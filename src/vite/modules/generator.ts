import type { DatabaseInfo, ActionInfo } from '../../db';
import { transformHandlerForDO, transformCrossDbCalls } from './parser';
import * as t from '@babel/types';
import _generate from '@babel/generator';
import { parse } from '@babel/parser';

// Handle both ESM and CJS module formats
const generate = typeof _generate === 'function'
  ? _generate
  : (_generate as unknown as { default: typeof _generate }).default;

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

export interface MethodConfig {
  action: ActionInfo;
  crossDbContext: CrossDbContext;
}

// ============================================================================
// AST Utilities
// ============================================================================

/** Parse a code snippet into an expression */
export function parseExpression(code: string): t.Expression {
  // Wrap in parens to handle object literals and other edge cases
  const wrapped = `(${code})`;
  const ast = parse(wrapped, { sourceType: 'module' });
  const stmt = ast.program.body[0];
  if (t.isExpressionStatement(stmt)) {
    return stmt.expression;
  }
  throw new Error(`Expected expression, got ${stmt.type}`);
}

/** Parse a property path like "session.shop" into a member expression chain with a base */
export function parseMemberPath(base: t.Expression, path: string): t.Expression {
  const parts = path.split('.');
  return parts.reduce<t.Expression>(
    (obj, prop) => t.memberExpression(obj, t.identifier(prop)),
    base
  );
}

/** Create an import declaration: import { specifiers } from source */
export function createNamedImport(names: string[], source: string): t.ImportDeclaration {
  const specifiers = names.map(name =>
    t.importSpecifier(t.identifier(name), t.identifier(name))
  );
  return t.importDeclaration(specifiers, t.stringLiteral(source));
}

/** Create a named export from source: export { names } from source */
export function createReExport(names: string[], source: string): t.ExportNamedDeclaration {
  const specifiers = names.map(name =>
    t.exportSpecifier(t.identifier(name), t.identifier(name))
  );
  return t.exportNamedDeclaration(null, specifiers, t.stringLiteral(source));
}

/** Generate code from statements */
export function generateFromStatements(statements: t.Statement[]): string {
  const file = t.file(t.program(statements));
  return generate(file, { comments: true }).code;
}

// ============================================================================
// RPC Stub Builders
// ============================================================================

/** Build the ID strategy expression */
export function buildIdStrategy(database: DatabaseInfo, shopIdPath: string): t.CallExpression {
  const binding = t.memberExpression(
    t.identifier('env'),
    t.identifier(database.bindingName)
  );
  const idFromName = t.memberExpression(binding, t.identifier('idFromName'));

  const key = database.instance === 'global'
    ? t.stringLiteral('global')
    : parseMemberPath(t.identifier('ctx'), shopIdPath);

  return t.callExpression(idFromName, [key]);
}

/** Build the RPC call expression */
/** Build the RPC call expression (ALWAYS calls stub.rpc) */
export function buildRpcCall(config: StubConfig): t.CallExpression {
  const { action, database, shopIdPath } = config;

  const instanceKey =
    database.instance === 'global'
      ? t.stringLiteral('global')
      : parseMemberPath(t.identifier('ctx'), shopIdPath);

  return t.callExpression(
    t.memberExpression(t.identifier('stub'), t.identifier('rpc')),
    [
      t.stringLiteral(action.exportName),
      t.identifier('validatedArgs'),
      t.objectExpression([t.objectProperty(t.identifier('instanceKey'), instanceKey)]),
    ]
  );
}

/** Build a stub function body as statements */
export function buildStubBodyStatements(config: StubConfig): t.Statement[] {
  const { action, database, shopIdPath } = config;

  const instanceKeyExpr =
    database.instance === 'global'
      ? t.stringLiteral('global')
      : parseMemberPath(t.identifier('ctx'), shopIdPath);

  const bindingExpr = t.memberExpression(
    t.identifier('env'),
    t.identifier(database.bindingName)
  );

  return [
    // const argsSchema = type({...});
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('argsSchema'),
        t.callExpression(t.identifier('type'), [
          parseExpression(action.argsSchemaSource),
        ])
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

    // const instanceKey = <global | ctx.session.shop ...>;
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
        t.callExpression(t.memberExpression(bindingExpr, t.identifier('get')), [
          t.identifier('id'),
        ])
      ),
    ]),

    // return stub.rpc("actionName", validatedArgs, { instanceKey });
    t.returnStatement(buildRpcCall(config)),
  ];
}

/** Build a complete stub function declaration */
export function buildStubFunction(config: StubConfig): t.ExportNamedDeclaration {
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

// ============================================================================
// Durable Object Builders
// ============================================================================

/** Transform the handler source for DO context */
function transformHandler(action: ActionInfo, crossDbContext: CrossDbContext): string {
  let handler = action.handlerSource;

  if (action.internalActionCalls.length > 0) {
    handler = transformHandlerForDO(handler, action.internalActionCalls);
  }

  if (action.crossDbActionCalls.length > 0) {
    handler = transformCrossDbCalls(
      handler,
      action.crossDbActionCalls,
      crossDbContext.actionToDatabase
    );
  }

  return handler;
}

/**
 * Exported wrapper: same transformation DO generation uses, reusable for registry/in-place.
 * (This is what you were missing after edits.)
 */
export function transformHandlerForRegistry(action: ActionInfo, crossDbContext: CrossDbContext): string {
  return transformHandler(action, crossDbContext);
}

/** Build the context setup statement for a DO method */
export function buildMethodContextStatement(action: ActionInfo): t.Statement | null {
  if (action.crossDbActionCalls.length === 0) {
    return null;
  }

  const ctxDecl = t.variableDeclaration('const', [
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
        )
      ])
    )
  ]);

  return ctxDecl;
}

/** Build a DO method */
export function buildDOMethod(config: MethodConfig): t.ClassMethod {
  const { action, crossDbContext } = config;
  const hasCrossDbCalls = action.crossDbActionCalls.length > 0;

  const sourceHint = action.sourceFile ? ` (defined in ${action.sourceFile})` : '';
  const transformedHandler = transformHandler(action, crossDbContext);

  // Parameters: args, and optionally rpcContext
  const params: t.Identifier[] = [t.identifier('args')];
  if (hasCrossDbCalls) {
    params.push(t.identifier('rpcContext'));
  }

  // Build body
  const bodyStatements: t.Statement[] = [];

  // await this.ensureMigrations();
  bodyStatements.push(
    t.expressionStatement(
      t.awaitExpression(
        t.callExpression(
          t.memberExpression(t.thisExpression(), t.identifier('ensureMigrations')),
          []
        )
      )
    )
  );

  // const validator = type({...});
  const validatorDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('validator'),
      t.callExpression(t.identifier('type'), [parseExpression(action.argsSchemaSource)])
    )
  ]);
  bodyStatements.push(validatorDecl);

  // const validated = validator(args);
  bodyStatements.push(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('validated'),
        t.callExpression(t.identifier('validator'), [t.identifier('args')])
      )
    ])
  );

  // if (validated instanceof type.errors) throw
  bodyStatements.push(
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
                t.templateElement({ raw: `Invalid args for ${action.exportName}${sourceHint}: ` }, false),
                t.templateElement({ raw: '' }, true)
              ],
              [t.memberExpression(t.identifier('validated'), t.identifier('summary'))]
            )
          ])
        )
      ])
    )
  );

  // Context setup (if needed)
  const ctxStatement = buildMethodContextStatement(action);
  if (ctxStatement) {
    bodyStatements.push(ctxStatement);
  }

  const handlerDecl = t.variableDeclaration('const', [
    t.variableDeclarator(t.identifier('handler'), parseExpression(transformedHandler))
  ]);
  bodyStatements.push(handlerDecl);

  // return handler(this.db, validated, ctx/undefined);
  bodyStatements.push(
    t.returnStatement(
      t.callExpression(t.identifier('handler'), [
        t.memberExpression(t.thisExpression(), t.identifier('db')),
        t.identifier('validated'),
        hasCrossDbCalls ? t.identifier('ctx') : t.identifier('undefined')
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

/** Build migrations object expression */
export function buildMigrationsObject(migrations?: Map<string, string[][]>): t.ObjectExpression {
  if (!migrations || migrations.size === 0) {
    return t.objectExpression([]);
  }

  const entries = Array.from(migrations.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, chunks]) => {
    const chunksArray = t.arrayExpression(
      chunks.map(chunk => t.arrayExpression(chunk.map(s => t.stringLiteral(s))))
    );

    return t.objectProperty(
      t.stringLiteral(name),
      t.objectExpression([t.objectProperty(t.identifier('chunks'), chunksArray)])
    );
  });

  return t.objectExpression(entries);
}

/** Build a complete DO class */
export function buildDOClass(
  database: DatabaseInfo,
  actions: ActionInfo[],
  crossDbContext: CrossDbContext
): t.ExportNamedDeclaration {
  const methods = actions.map(action => buildDOMethod({ action, crossDbContext }));

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
// Cross-DB Context Builder  (RESTORED + EXPORTED)
// ============================================================================

/** Build the cross-DB context from databases and their actions */
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

// ============================================================================
// Public API (RESTORED + EXPORTED)
// ============================================================================

/**
 * Generate RPC stub code for a database's actions
 */
export function generateRpcStubs(
  database: DatabaseInfo,
  actions: ActionInfo[],
  options: GeneratorOptions
): string {
  if (actions.length === 0) {
    return `// No actions defined for ${database.name}`;
  }

  const statements: t.Statement[] = [
    createNamedImport(['getContext'], options.contextImport),
    createNamedImport(['type'], 'arktype'),
    ...actions.map(action =>
      buildStubFunction({ action, database, shopIdPath: options.shopIdPath })
    )
  ];

  return generateFromStatements(statements);
}

/**
 * Generate the complete Durable Objects module
 */
export function generateDurableObjectsModule(
  databases: DatabaseInfo[],
  actionsByDatabase: Map<string, ActionInfo[]>,
  _allActions: ActionInfo[]
): string {
  const crossDbContext = buildCrossDbContext(databases, actionsByDatabase);

  const statements: t.Statement[] = [
    createNamedImport(['SqliteDurableObject'], '@shoplayer/database/db'),
    createNamedImport(['type'], 'arktype'),
    ...databases.map(db => {
      const dbActions = actionsByDatabase.get(db.name) ?? [];
      return buildDOClass(db, dbActions, crossDbContext);
    })
  ];

  return generateFromStatements(statements);
}

// ============================================================================
// NEW: Action Registry module + In-place action file transform
// ============================================================================

type __ParsePlugins = ('typescript' | 'jsx')[];

function __parseProgramTs(code: string, plugins: __ParsePlugins = ['typescript', 'jsx']): t.File {
  return parse(code, { sourceType: 'module', plugins }) as unknown as t.File;
}

function __ensureNamedImports(body: t.Statement[], source: string, names: string[]): void {
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

function __generateWithMap(ast: t.File, sourceFileName?: string) {
  const out = generate(ast, { sourceMaps: true, sourceFileName, comments: true });
  return { code: out.code, map: out.map };
}

/**
 * Virtual registry module. (Babel-generated string, per your convention.)
 */
export function generateActionRegistryModule(): string {
  const stmts: t.Statement[] = [
    createNamedImport(['type'], 'arktype'),
    // const KEY = '__shoplayer_action_registry__'
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier('KEY'), t.stringLiteral('__shoplayer_action_registry__')),
    ]),
    // const root = globalThis
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier('root'), t.identifier('globalThis')),
    ]),
    // const registry = root[KEY] ??= { byDb: new Map() }
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('registry'),
        t.assignmentExpression(
          '??=',
          t.memberExpression(t.identifier('root'), t.identifier('KEY'), true),
          t.objectExpression([
            t.objectProperty(t.identifier('byDb'), t.newExpression(t.identifier('Map'), [])),
          ])
        )
      ),
    ]),

    // export function registerAction(dbName, actionName, def) { ... }
    t.exportNamedDeclaration(
      t.functionDeclaration(
        t.identifier('registerAction'),
        [t.identifier('dbName'), t.identifier('actionName'), t.identifier('def')],
        t.blockStatement([
          t.variableDeclaration('let', [
            t.variableDeclarator(
              t.identifier('dbMap'),
              t.callExpression(
                t.memberExpression(t.memberExpression(t.identifier('registry'), t.identifier('byDb')), t.identifier('get')),
                [t.identifier('dbName')]
              )
            ),
          ]),
          t.ifStatement(
            t.unaryExpression('!', t.identifier('dbMap')),
            t.blockStatement([
              t.expressionStatement(
                t.assignmentExpression('=', t.identifier('dbMap'), t.newExpression(t.identifier('Map'), []))
              ),
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(t.memberExpression(t.identifier('registry'), t.identifier('byDb')), t.identifier('set')),
                  [t.identifier('dbName'), t.identifier('dbMap')]
                )
              ),
            ])
          ),
          t.expressionStatement(
            t.callExpression(t.memberExpression(t.identifier('dbMap'), t.identifier('set')), [
              t.identifier('actionName'),
              t.identifier('def'),
            ])
          ),
        ])
      )
    ),

    // export function getAction(dbName, actionName) { ... }
    t.exportNamedDeclaration(
      t.functionDeclaration(
        t.identifier('getAction'),
        [t.identifier('dbName'), t.identifier('actionName')],
        t.blockStatement([
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier('dbMap'),
              t.callExpression(
                t.memberExpression(t.memberExpression(t.identifier('registry'), t.identifier('byDb')), t.identifier('get')),
                [t.identifier('dbName')]
              )
            ),
          ]),
          t.returnStatement(
            t.conditionalExpression(
              t.identifier('dbMap'),
              t.callExpression(t.memberExpression(t.identifier('dbMap'), t.identifier('get')), [t.identifier('actionName')]),
              t.identifier('undefined')
            )
          ),
        ])
      )
    ),
  ];

  return generateFromStatements(stmts);
}

/**
 * In-place file transform: replaces exported action constants with:
 * - validator const
 * - handler const (transformed)
 * - registerAction(...)
 * - exported RPC stub function (same as generateRpcStubs logic)
 *
 * IMPORTANT: This keeps the handler in the original file scope.
 */
export function transformActionFileInPlace(args: {
  code: string;
  sourceFileName?: string;
  dbName: string;
  database: DatabaseInfo;
  actionsInFile: ActionInfo[];
  contextImport: string;
  shopIdPath: string;
  registryImport: string; // e.g. 'virtual:shoplayer/databases/__actionRegistry'
  transformedHandlers: Map<string, string>; // exportName -> handler source
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
    transformedHandlers,
  } = args;

  const actionNames = new Set(actionsInFile.map(a => a.exportName));
  if (actionNames.size === 0) return { code, map: null };

  const ast = __parseProgramTs(code);
  const body = ast.program.body;

  __ensureNamedImports(body, 'arktype', ['type']);
  __ensureNamedImports(body, contextImport, ['getContext']);
  __ensureNamedImports(body, registryImport, ['registerAction']);

  const out: t.Statement[] = [];

  for (const stmt of body) {
    // Only handle: export const X = ...
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration && t.isVariableDeclaration(stmt.declaration)) {
      const decl = stmt.declaration;

      const replaced: t.Statement[] = [];
      const remaining: t.VariableDeclarator[] = [];

      for (const d of decl.declarations) {
        if (t.isIdentifier(d.id) && actionNames.has(d.id.name)) {
          const exportName = d.id.name;
          const action = actionsInFile.find(a => a.exportName === exportName)!;

          const validatorId = t.identifier(`__validator_${exportName}`);
          const handlerId = t.identifier(`__handler_${exportName}`);

          const handlerSource = transformedHandlers.get(exportName) ?? action.handlerSource;

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
              t.variableDeclarator(handlerId, parseExpression(handlerSource)),
            ])
          );

          // registerAction(dbName, "X", { validator: (args)=>..., handler: ... })
          // NOTE: keep validator callable form consistent with your DO method pattern
          replaced.push(
            t.expressionStatement(
              t.callExpression(t.identifier('registerAction'), [
                t.stringLiteral(dbName),
                t.stringLiteral(exportName),
                t.objectExpression([
                  t.objectProperty(
                    t.identifier('validator'),
                    // (args) => __validator_X(args)
                    t.arrowFunctionExpression(
                      [t.identifier('args')],
                      t.callExpression(validatorId, [t.identifier('args')])
                    )
                  ),
                  t.objectProperty(t.identifier('handler'), handlerId),
                ])
              ])
            )
          );

          // export async function X(args) { ... RPC stub ... }
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
  return __generateWithMap(ast, sourceFileName);
}

/**
 * One-call helper: uses your restored exports:
 * - buildCrossDbContext
 * - transformHandlerForRegistry (same DO logic)
 * and then does in-place rewrite.
 */
export function transformActionFileInPlaceWithCrossDb(args: {
  code: string;
  sourceFileName?: string;

  dbName: string;
  database: DatabaseInfo;
  actionsInFile: ActionInfo[];

  allDatabases: DatabaseInfo[];
  allActions: ActionInfo[];

  contextImport: string;
  shopIdPath: string;
  registryImport: string;
}): { code: string; map: any } {
  const {
    code,
    sourceFileName,
    dbName,
    database,
    actionsInFile,
    allDatabases,
    allActions,
    contextImport,
    shopIdPath,
    registryImport,
  } = args;

  const actionsByDb = new Map<string, ActionInfo[]>();
  for (const a of allActions) {
    const list = actionsByDb.get(a.databaseName) ?? [];
    list.push(a);
    actionsByDb.set(a.databaseName, list);
  }

  const crossDbContext = buildCrossDbContext(allDatabases, actionsByDb);

  const transformedHandlers = new Map<string, string>();
  for (const a of actionsInFile) {
    transformedHandlers.set(a.exportName, transformHandlerForRegistry(a, crossDbContext));
  }

  return transformActionFileInPlace({
    code,
    sourceFileName,
    dbName,
    database,
    actionsInFile,
    contextImport,
    shopIdPath,
    registryImport,
    transformedHandlers,
  });
}
