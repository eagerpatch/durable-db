import type { DatabaseInfo, ActionInfo } from '../../db';

// Keep these exports alive if you already rely on them.
import { transformHandlerForDO, transformCrossDbCalls } from './parser';

import * as t from '@babel/types';
import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// Handle ESM/CJS babel packages
const generate =
  typeof _generate === 'function'
    ? _generate
    : (_generate as unknown as { default: typeof _generate }).default;

const traverse: typeof _traverse =
  typeof (_traverse as any) === 'function'
    ? (_traverse as any)
    : ((_traverse as any).default as any);

// ============================================================================
// Types
// ============================================================================

export interface GeneratorOptions {
  contextImport: string;
  shopIdPath: string;
}

export interface CrossDbContext {
  actionToDatabase: Map<string, DatabaseInfo>;
}

export interface StubConfig {
  action: ActionInfo;
  database: DatabaseInfo;
  shopIdPath: string;
}

// ============================================================================
// Parser helpers
// ============================================================================

const PARSER_PLUGINS: any[] = [
  'typescript',
  'jsx',
  'topLevelAwait',
  'decorators-legacy',
  'classProperties',
];

function parseProgram(code: string): t.File {
  return parse(code, { sourceType: 'module', plugins: PARSER_PLUGINS }) as unknown as t.File;
}

export function parseExpression(code: string): t.Expression {
  const wrapped = `(${code.trim().replace(/;\s*$/, '')})`;
  const ast = parse(wrapped, { sourceType: 'module', plugins: PARSER_PLUGINS });
  const stmt = ast.program.body[0];
  if (t.isExpressionStatement(stmt)) return stmt.expression;
  throw new Error(`Expected expression, got ${stmt?.type ?? 'unknown'}`);
}

export function parseMemberPath(base: t.Expression, path: string): t.Expression {
  const parts = path.split('.');
  return parts.reduce<t.Expression>(
    (obj, prop) => t.memberExpression(obj, t.identifier(prop)),
    base
  );
}

export function createNamedImport(names: string[], source: string): t.ImportDeclaration {
  const specifiers = names.map((name) =>
    t.importSpecifier(t.identifier(name), t.identifier(name))
  );
  return t.importDeclaration(specifiers, t.stringLiteral(source));
}

function ensureNamedImports(body: t.Statement[], source: string, names: string[]): void {
  const existing = body.find(
    (s): s is t.ImportDeclaration => t.isImportDeclaration(s) && s.source.value === source
  );

  if (!existing) {
    let insertAt = 0;
    while (insertAt < body.length && t.isImportDeclaration(body[insertAt])) insertAt++;
    body.splice(insertAt, 0, createNamedImport(names, source));
    return;
  }

  const have = new Set(
    existing.specifiers
    .filter((sp) => t.isImportSpecifier(sp))
    .map((sp) => (sp.imported as t.Identifier).name)
  );

  for (const n of names) {
    if (!have.has(n)) {
      existing.specifiers.push(t.importSpecifier(t.identifier(n), t.identifier(n)));
    }
  }
}

function generateWithMap(ast: t.File, sourceFileName?: string) {
  const out = generate(ast, { sourceMaps: true, sourceFileName, comments: true });
  return { code: out.code, map: out.map };
}

export function generateFromStatements(statements: t.Statement[]): string {
  const file = t.file(t.program(statements));
  return generate(file, { comments: true }).code;
}

// ============================================================================
// Registry virtual module (virtual:shoplayer/databases/__actionRegistry)
// ============================================================================

export const VIRTUAL_REGISTRY_ID = 'shoplayer/databases/__actionRegistry';

/**
 * Registry module responsibilities:
 * - store action implementations (validator + handler) keyed by db/action
 * - expose AsyncLocalStorage context for DO-local short path
 * - provide callActionIn for cross-db hopping (validated)
 * - provide callActionInValidated for DO-local “already validated” calls
 */
export function generateActionRegistryModule(): string {
  return `
import { type } from 'arktype';
import { AsyncLocalStorage } from 'node:async_hooks';

const byDb = new Map();
const als = new AsyncLocalStorage();

/** Register an action implementation */
export function registerAction(dbName, actionName, def) {
  let dbMap = byDb.get(dbName);
  if (!dbMap) {
    dbMap = new Map();
    byDb.set(dbName, dbMap);
  }
  dbMap.set(actionName, def);
}

/** Get an action definition */
export function getAction(dbName, actionName) {
  const dbMap = byDb.get(dbName);
  return dbMap ? dbMap.get(actionName) : undefined;
}

/** DurableObject-local context: { db, ctx, dbName, instanceKey } */
export function getDoContext() {
  return als.getStore();
}

export function runWithDoContext(store, fn) {
  return als.run(store, fn);
}

function getOrThrow(dbName, actionName) {
  const entry = getAction(dbName, actionName);
  if (!entry) {
    throw new Error('[shoplayer-database] Action not registered: ' + dbName + '/' + actionName);
  }
  return entry;
}

/**
 * Like callActionIn, but assumes args are already validated.
 * Used by stubs when they’re running inside the DO (ALS store exists).
 */
export async function callActionInValidated(db, targetDb, actionName, validatedArgs, ctx) {
  const entry = getOrThrow(targetDb, actionName);

  // Same DB: direct invocation (no RPC)
  if (ctx && ctx.dbName === targetDb) {
    return entry.handler(db, validatedArgs, ctx);
  }

  // Cross DB: hop
  const env = ctx?.env;
  const bindingName = ctx?.dbBindingNames?.[targetDb];
  if (!env || !bindingName) {
    throw new Error('[shoplayer-database] Missing env/binding for db: ' + targetDb);
  }

  const binding = env[bindingName];
  const instanceKey = ctx.instanceKey ?? 'global';

  const id = binding.idFromName(instanceKey);
  const stub = binding.get(id);

  return stub.rpc(actionName, validatedArgs, { instanceKey });
}

/**
 * Validating entry point for userland callers.
 */
export async function callActionIn(db, targetDb, actionName, args, ctx) {
  const entry = getOrThrow(targetDb, actionName);

  const validated = entry.validator(args);
  if (validated instanceof type.errors) {
    throw new Error('[shoplayer-database] Invalid args: ' + validated.summary);
  }

  return callActionInValidated(db, targetDb, actionName, validated, ctx);
}
`.trim();
}

// ============================================================================
// Stub generation (DO-local short path via AsyncLocalStorage)
// ============================================================================

function buildRpcCall(config: StubConfig): t.CallExpression {
  const { action } = config;

  return t.callExpression(
    t.memberExpression(t.identifier('stub'), t.identifier('rpc')),
    [
      t.stringLiteral(action.exportName),
      t.identifier('validatedArgs'),
      t.objectExpression([
        t.objectProperty(t.identifier('instanceKey'), t.identifier('instanceKey')),
      ]),
    ]
  );
}

function buildDoShortPath(config: StubConfig): t.Statement[] {
  const { action, database } = config;

  // const __do = getDoContext();
  const doDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__do'),
      t.callExpression(t.identifier('getDoContext'), [])
    ),
  ]);

  // if (__do && __do.dbName === "<db>") return callActionInValidated(__do.db, "<db>", "<action>", validatedArgs, __do.ctx);
  const fastIf = t.ifStatement(
    t.logicalExpression(
      '&&',
      t.identifier('__do'),
      t.binaryExpression(
        '===',
        t.memberExpression(t.identifier('__do'), t.identifier('dbName')),
        t.stringLiteral(database.name)
      )
    ),
    t.blockStatement([
      t.returnStatement(
        t.callExpression(t.identifier('callActionInValidated'), [
          t.memberExpression(t.identifier('__do'), t.identifier('db')),
          t.stringLiteral(database.name),
          t.stringLiteral(action.exportName),
          t.identifier('validatedArgs'),
          t.memberExpression(t.identifier('__do'), t.identifier('ctx')),
        ])
      ),
    ])
  );

  return [doDecl, fastIf];
}

function buildStubBodyStatements(config: StubConfig): t.Statement[] {
  const { action, database, shopIdPath } = config;

  const bindingExpr = t.memberExpression(t.identifier('env'), t.identifier(database.bindingName));

  const instanceKeyExpr =
    database.instance === 'global'
      ? t.stringLiteral('global')
      : parseMemberPath(t.identifier('ctx'), shopIdPath);

  return [
    // const argsSchema = type({...});
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('argsSchema'),
        t.callExpression(t.identifier('type'), [parseExpression(action.argsSchemaSource)])
      ),
    ]),

    // const validatedArgs = argsSchema.assert(args);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('validatedArgs'),
        t.callExpression(
          t.memberExpression(t.identifier('argsSchema'), t.identifier('assert')),
          [t.identifier('args')]
        )
      ),
    ]),

    // DO-local short path (no RPC)
    ...buildDoShortPath(config),

    // const ctx = getContext();
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('ctx'),
        t.callExpression(t.identifier('getContext'), [])
      ),
    ]),

    // const env = ctx.env;
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('env'),
        t.memberExpression(t.identifier('ctx'), t.identifier('env'))
      ),
    ]),

    // const instanceKey = ...
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier('instanceKey'), instanceKeyExpr),
    ]),

    // const id = env.BINDING.idFromName(instanceKey);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('id'),
        t.callExpression(
          t.memberExpression(bindingExpr, t.identifier('idFromName')),
          [t.identifier('instanceKey')]
        )
      ),
    ]),

    // const stub = env.BINDING.get(id);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('stub'),
        t.callExpression(
          t.memberExpression(bindingExpr, t.identifier('get')),
          [t.identifier('id')]
        )
      ),
    ]),

    // return stub.rpc(...)
    t.returnStatement(buildRpcCall(config)),
  ];
}

function buildStubFunction(config: StubConfig): t.ExportNamedDeclaration {
  const { action } = config;

  const funcDecl = t.functionDeclaration(
    t.identifier(action.exportName),
    [t.identifier('args')],
    t.blockStatement(buildStubBodyStatements(config)),
    false,
    true
  );

  return t.exportNamedDeclaration(funcDecl);
}

export function generateRpcStubs(
  database: DatabaseInfo,
  actions: ActionInfo[],
  options: GeneratorOptions
): string {
  const statements: t.Statement[] = [
    createNamedImport(['getContext'], options.contextImport),
    createNamedImport(['type'], 'arktype'),
    // for DO-local short path
    createNamedImport(['getDoContext', 'callActionInValidated'], `virtual:${VIRTUAL_REGISTRY_ID}`),
    ...actions.map((action) =>
      buildStubFunction({ action, database, shopIdPath: options.shopIdPath })
    ),
  ];

  return generateFromStatements(statements);
}

// ============================================================================
// Classic Cross-db context + classic DO module (kept so exports don’t regress)
// ============================================================================

export function buildCrossDbContext(
  databases: DatabaseInfo[],
  actionsByDatabase: Map<string, ActionInfo[]>
): CrossDbContext {
  const actionToDatabase = new Map<string, DatabaseInfo>();

  for (const db of databases) {
    const dbActions = actionsByDatabase.get(db.name) ?? [];
    for (const action of dbActions) {
      actionToDatabase.set(action.exportName, db);
    }
  }

  return { actionToDatabase };
}

export function generateDurableObjectsModule(
  databases: DatabaseInfo[],
  actionsByDatabase: Map<string, ActionInfo[]>,
  _allActions: ActionInfo[]
): string {
  const crossDbContext = buildCrossDbContext(databases, actionsByDatabase);

  const statements: t.Statement[] = [
    createNamedImport(['SqliteDurableObject'], '@shoplayer/database/db'),
    createNamedImport(['type'], 'arktype'),
    ...databases.map((db) => buildDOClass(db, actionsByDatabase.get(db.name) ?? [], crossDbContext)),
  ];

  return generateFromStatements(statements);
}

function buildMigrationsObject(migrations?: Map<string, string[][]>): t.ObjectExpression {
  if (!migrations || migrations.size === 0) return t.objectExpression([]);

  const entries = Array.from(migrations.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, chunks]) => {
    const chunksArray = t.arrayExpression(
      chunks.map((chunk) => t.arrayExpression(chunk.map((s) => t.stringLiteral(s))))
    );

    return t.objectProperty(
      t.stringLiteral(name),
      t.objectExpression([t.objectProperty(t.identifier('chunks'), chunksArray)])
    );
  });

  return t.objectExpression(entries);
}

function buildDOMethod(action: ActionInfo, crossDbContext: CrossDbContext): t.ClassMethod {
  const hasCrossDbCalls = !!action.crossDbActionCalls?.length;

  let handler = action.handlerSource;

  if (action.internalActionCalls?.length) {
    handler = transformHandlerForDO(handler, action.internalActionCalls);
  }

  if (action.crossDbActionCalls?.length) {
    handler = transformCrossDbCalls(handler, action.crossDbActionCalls, crossDbContext.actionToDatabase);
  }

  const params: t.Identifier[] = [t.identifier('args')];
  if (hasCrossDbCalls) params.push(t.identifier('rpcContext'));

  const bodyStatements: t.Statement[] = [
    t.expressionStatement(
      t.awaitExpression(
        t.callExpression(
          t.memberExpression(t.thisExpression(), t.identifier('ensureMigrations')),
          []
        )
      )
    ),
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('validator'),
        t.callExpression(t.identifier('type'), [parseExpression(action.argsSchemaSource)])
      ),
    ]),
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('validated'),
        t.callExpression(t.identifier('validator'), [t.identifier('args')])
      ),
    ]),
    t.ifStatement(
      t.binaryExpression(
        'instanceof',
        t.identifier('validated'),
        t.memberExpression(t.identifier('type'), t.identifier('errors'))
      ),
      t.blockStatement([
        t.throwStatement(
          t.newExpression(t.identifier('Error'), [
            t.templateLiteral(
              [
                t.templateElement({ raw: `Invalid args for ${action.exportName}: ` }, false),
                t.templateElement({ raw: '' }, true),
              ],
              [t.memberExpression(t.identifier('validated'), t.identifier('summary'))]
            ),
          ])
        ),
      ])
    ),
  ];

  if (hasCrossDbCalls) {
    bodyStatements.push(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('ctx'),
          t.objectExpression([
            t.objectProperty(
              t.identifier('env'),
              t.memberExpression(t.thisExpression(), t.identifier('env'))
            ),
            t.objectProperty(
              t.identifier('instanceKey'),
              t.logicalExpression(
                '??',
                t.optionalMemberExpression(
                  t.identifier('rpcContext'),
                  t.identifier('instanceKey'),
                  false,
                  true
                ),
                t.stringLiteral('global')
              )
            ),
          ])
        ),
      ])
    );
  }

  bodyStatements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier('handler'), parseExpression(handler)),
    ])
  );

  bodyStatements.push(
    t.returnStatement(
      t.callExpression(t.identifier('handler'), [
        t.memberExpression(t.thisExpression(), t.identifier('db')),
        t.identifier('validated'),
        hasCrossDbCalls ? t.identifier('ctx') : t.identifier('undefined'),
      ])
    )
  );

  return t.classMethod(
    'method',
    t.identifier(action.exportName),
    params,
    t.blockStatement(bodyStatements),
    false,
    false,
    false,
    true
  );
}

function buildDOClass(
  database: DatabaseInfo,
  actions: ActionInfo[],
  crossDbContext: CrossDbContext
): t.ExportNamedDeclaration {
  const methods = actions.map((a) => buildDOMethod(a, crossDbContext));

  const migrationsProperty = t.classProperty(
    t.identifier('migrations'),
    buildMigrationsObject(database.migrations)
  );

  const classDecl = t.classDeclaration(
    t.identifier(database.className),
    t.identifier('SqliteDurableObject'),
    t.classBody([migrationsProperty, ...methods])
  );

  return t.exportNamedDeclaration(classDecl);
}

// ============================================================================
// In-place transform (minimal, just registration + stub replacement)
// ============================================================================

export function transformActionFileInPlaceWithALSShortPath(args: {
  code: string;
  sourceFileName?: string;

  dbName: string;
  database: DatabaseInfo;
  actionsInFile: ActionInfo[];

  contextImport: string;
  shopIdPath: string;
  registryImport: string; // `virtual:${VIRTUAL_REGISTRY_ID}`
}): { code: string; map: any } {
  const {
    code,
    sourceFileName,
    dbName,
    database,
    actionsInFile,
    contextImport,
    shopIdPath,
    registryImport,
  } = args;

  if (actionsInFile.length === 0) return { code, map: null };

  const actionNames = new Set(actionsInFile.map((a) => a.exportName));
  const ast = parseProgram(code);
  const body = ast.program.body;

  ensureNamedImports(body, 'arktype', ['type']);
  ensureNamedImports(body, contextImport, ['getContext']);
  ensureNamedImports(body, registryImport, ['registerAction', 'getDoContext', 'callActionInValidated']);

  const out: t.Statement[] = [];

  for (const stmt of body) {
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration && t.isVariableDeclaration(stmt.declaration)) {
      const decl = stmt.declaration;

      const replaced: t.Statement[] = [];
      const remaining: t.VariableDeclarator[] = [];

      for (const d of decl.declarations) {
        if (t.isIdentifier(d.id) && actionNames.has(d.id.name)) {
          const exportName = d.id.name;
          const action = actionsInFile.find((a) => a.exportName === exportName)!;

          const validatorId = t.identifier(`__validator_${exportName}`);
          const handlerId = t.identifier(`__handler_${exportName}`);

          // const __validator_X = type(<schema>);
          replaced.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                validatorId,
                t.callExpression(t.identifier('type'), [parseExpression(action.argsSchemaSource)])
              ),
            ])
          );

          // const __handler_X = (<handler>);
          replaced.push(
            t.variableDeclaration('const', [
              t.variableDeclarator(handlerId, parseExpression(action.handlerSource)),
            ])
          );

          // registerAction(dbName, "X", { validator: (args)=>__validator_X(args), handler: __handler_X })
          replaced.push(
            t.expressionStatement(
              t.callExpression(t.identifier('registerAction'), [
                t.stringLiteral(dbName),
                t.stringLiteral(exportName),
                t.objectExpression([
                  t.objectProperty(
                    t.identifier('validator'),
                    t.arrowFunctionExpression(
                      [t.identifier('args')],
                      t.callExpression(validatorId, [t.identifier('args')])
                    )
                  ),
                  t.objectProperty(t.identifier('handler'), handlerId),
                ]),
              ])
            )
          );

          // export async function X(args) { ...stub... }
          const funcDecl = t.functionDeclaration(
            t.identifier(exportName),
            [t.identifier('args')],
            t.blockStatement(buildStubBodyStatements({ action, database, shopIdPath })),
            false,
            true
          );

          replaced.push(t.exportNamedDeclaration(funcDecl));
        } else {
          remaining.push(d);
        }
      }

      if (replaced.length > 0) {
        if (remaining.length > 0) {
          out.push(t.exportNamedDeclaration(t.variableDeclaration(decl.kind, remaining)));
        }
        out.push(...replaced);
        continue;
      }
    }

    out.push(stmt);
  }

  ast.program.body = out;
  return generateWithMap(ast, sourceFileName);
}
