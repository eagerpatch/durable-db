import type { DatabaseInfo, ActionInfo } from '../../db';

import * as t from '@babel/types';
import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import { BABEL_PARSER_PLUGINS } from './parser';

// Handle ESM/CJS babel packages
const generate =
  typeof _generate === 'function'
    ? _generate
    : (_generate as unknown as { default: typeof _generate }).default;

// ============================================================================
// Types
// ============================================================================

export interface TransformOptions {
  code: string;
  sourceFileName?: string;
  dbName: string;
  database: DatabaseInfo;
  actionsInFile: ActionInfo[];
  contextImport: string;
  shopIdPath: string;
  registryImport: string;
}

interface StubConfig {
  action: ActionInfo;
  database: DatabaseInfo;
  shopIdPath: string;
}

// ============================================================================
// Parser Utilities
// ============================================================================

function parseProgram(code: string): t.File {
  return parse(code, { sourceType: 'module', plugins: BABEL_PARSER_PLUGINS }) as unknown as t.File;
}

export function parseExpression(code: string): t.Expression {
  const wrapped = `(${code.trim().replace(/;\s*$/, '')})`;
  const ast = parse(wrapped, { sourceType: 'module', plugins: BABEL_PARSER_PLUGINS });
  const stmt = ast.program.body[0];
  if (t.isExpressionStatement(stmt)) return stmt.expression;
  throw new Error(`Expected expression, got ${stmt?.type ?? 'unknown'}`);
}

function parseMemberPath(base: t.Expression, path: string): t.Expression {
  return path.split('.').reduce<t.Expression>(
    (obj, prop) => t.memberExpression(obj, t.identifier(prop)),
    base
  );
}

// ============================================================================
// AST Builders - Imports
// ============================================================================

function createNamedImport(names: string[], source: string): t.ImportDeclaration {
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
    .filter((sp): sp is t.ImportSpecifier => t.isImportSpecifier(sp))
    .map((sp) => ((sp.imported as t.Identifier).name))
  );

  for (const n of names) {
    if (!have.has(n)) {
      existing.specifiers.push(t.importSpecifier(t.identifier(n), t.identifier(n)));
    }
  }
}

// ============================================================================
// AST Builders - Objects & Literals
// ============================================================================

function buildMigrationsObject(migrations?: Map<string, string[][]>): t.ObjectExpression {
  if (!migrations || migrations.size === 0) {
    return t.objectExpression([]);
  }

  const sorted = Array.from(migrations.entries()).sort(([a], [b]) => a.localeCompare(b));

  const properties = sorted.map(([name, chunks]) => {
    const chunksArray = t.arrayExpression(
      chunks.map((chunk) =>
        t.arrayExpression(chunk.map((stmt) => t.stringLiteral(stmt)))
      )
    );

    return t.objectProperty(
      t.stringLiteral(name),
      t.objectExpression([t.objectProperty(t.identifier('chunks'), chunksArray)])
    );
  });

  return t.objectExpression(properties);
}

function buildBindingNamesObject(databases: DatabaseInfo[]): t.ObjectExpression {
  const properties = databases.map((db) =>
    t.objectProperty(t.stringLiteral(db.name), t.stringLiteral(db.bindingName))
  );
  return t.objectExpression(properties);
}

// ============================================================================
// Code Generation
// ============================================================================

function generateCode(ast: t.File): string {
  return generate(ast, { comments: true }).code;
}

function generateWithMap(ast: t.File, sourceFileName?: string) {
  return generate(ast, { sourceMaps: true, sourceFileName, comments: true });
}

// ============================================================================
// Durable Objects Module Generation
// ============================================================================

export function generateDurableObjectsModule(
  databases: DatabaseInfo[],
  registryImport: string
): string {
  const bindingNamesExpr = buildBindingNamesObject(databases);

  const imports: t.ImportDeclaration[] = [
    createNamedImport(['SqliteDurableObject'], '@shoplayer/database/db'),
    createNamedImport(['type'], 'arktype'),
    createNamedImport(['getAction', 'runWithDoContext'], registryImport),
  ];

  const classes = databases.map((db) => buildDurableObjectClass(db, bindingNamesExpr));

  const program = t.program([...imports, ...classes]);
  return generateCode(t.file(program));
}

function buildDurableObjectClass(
  db: DatabaseInfo,
  bindingNamesExpr: t.ObjectExpression
): t.ExportNamedDeclaration {
  // migrations = { ... }
  const migrationsProperty = t.classProperty(
    t.identifier('migrations'),
    buildMigrationsObject(db.migrations)
  );

  // async rpc(method, args, rpcContext) { ... }
  const rpcMethod = buildRpcMethod(db, bindingNamesExpr);

  const classDecl = t.classDeclaration(
    t.identifier(db.className),
    t.identifier('SqliteDurableObject'),
    t.classBody([migrationsProperty, rpcMethod])
  );

  return t.exportNamedDeclaration(classDecl);
}

function buildRpcMethod(
  db: DatabaseInfo,
  bindingNamesExpr: t.ObjectExpression
): t.ClassMethod {
  const dbNameLiteral = t.stringLiteral(db.name);

  const body = t.blockStatement([
    // await this.ensureMigrations();
    t.expressionStatement(
      t.awaitExpression(
        t.callExpression(
          t.memberExpression(t.thisExpression(), t.identifier('ensureMigrations')),
          []
        )
      )
    ),

    // const entry = getAction("dbName", method);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('entry'),
        t.callExpression(t.identifier('getAction'), [dbNameLiteral, t.identifier('method')])
      ),
    ]),

    // if (!entry) { throw new Error(...) }
    t.ifStatement(
      t.unaryExpression('!', t.identifier('entry')),
      t.blockStatement([
        t.throwStatement(
          t.newExpression(t.identifier('Error'), [
            t.templateLiteral(
              [
                t.templateElement({ raw: `[shoplayer-database] Unknown action "`, cooked: `[shoplayer-database] Unknown action "` }, false),
                t.templateElement({ raw: `" for db "${db.name}" (was it imported?)`, cooked: `" for db "${db.name}" (was it imported?)` }, true),
              ],
              [t.identifier('method')]
            ),
          ])
        ),
      ])
    ),

    // const validated = entry.validator(args);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('validated'),
        t.callExpression(
          t.memberExpression(t.identifier('entry'), t.identifier('validator')),
          [t.identifier('args')]
        )
      ),
    ]),

    // if (validated instanceof type.errors) { throw new Error(...) }
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
                t.templateElement({ raw: `[shoplayer-database] Invalid args for "`, cooked: `[shoplayer-database] Invalid args for "` }, false),
                t.templateElement({ raw: `": `, cooked: `": ` }, false),
                t.templateElement({ raw: '', cooked: '' }, true),
              ],
              [
                t.identifier('method'),
                t.memberExpression(t.identifier('validated'), t.identifier('summary')),
              ]
            ),
          ])
        ),
      ])
    ),

    // const ctx = { env: this.env, dbName: "...", dbBindingNames: {...}, instanceKey: ... };
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('ctx'),
        t.objectExpression([
          t.objectProperty(
            t.identifier('env'),
            t.memberExpression(t.thisExpression(), t.identifier('env'))
          ),
          t.objectProperty(t.identifier('dbName'), dbNameLiteral),
          t.objectProperty(t.identifier('dbBindingNames'), bindingNamesExpr),
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
    ]),

    // return runWithDoContext({ db: this.db, ctx, dbName: "...", instanceKey: ctx.instanceKey }, async () => ...)
    t.returnStatement(
      t.callExpression(t.identifier('runWithDoContext'), [
        t.objectExpression([
          t.objectProperty(
            t.identifier('db'),
            t.memberExpression(t.thisExpression(), t.identifier('db'))
          ),
          t.objectProperty(t.identifier('ctx'), t.identifier('ctx')),
          t.objectProperty(t.identifier('dbName'), dbNameLiteral),
          t.objectProperty(
            t.identifier('instanceKey'),
            t.memberExpression(t.identifier('ctx'), t.identifier('instanceKey'))
          ),
        ]),
        t.arrowFunctionExpression(
          [],
          t.callExpression(
            t.memberExpression(t.identifier('entry'), t.identifier('handler')),
            [
              t.memberExpression(t.thisExpression(), t.identifier('db')),
              t.identifier('validated'),
              t.identifier('ctx'),
            ]
          ),
          true // async
        ),
      ])
    ),
  ]);

  return t.classMethod(
    'method',
    t.identifier('rpc'),
    [t.identifier('method'), t.identifier('args'), t.identifier('rpcContext')],
    body,
    false, // computed
    false, // static
    false, // generator
    true   // async
  );
}

// ============================================================================
// Stub Body Generation (for DO-local short path via ALS)
// ============================================================================

function buildRpcCall(action: ActionInfo): t.CallExpression {
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

  // if (__do && __do.dbName === "dbName") { return callActionInValidated(...) }
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

    // DO-local short path
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
    t.returnStatement(buildRpcCall(action)),
  ];
}

// ============================================================================
// Action File Transform
// ============================================================================

export function transformActionFile(options: TransformOptions) {
  const {
    code,
    sourceFileName,
    dbName,
    database,
    actionsInFile,
    contextImport,
    shopIdPath,
    registryImport,
  } = options;

  if (actionsInFile.length === 0) return null;

  const actionNames = new Set(actionsInFile.map((a) => a.exportName));
  const ast = parseProgram(code);
  const body = ast.program.body;

  ensureNamedImports(body, 'arktype', ['type']);
  ensureNamedImports(body, contextImport, ['getContext']);
  ensureNamedImports(body, registryImport, ['registerAction', 'getDoContext', 'callActionInValidated']);

  const out: t.Statement[] = [];

  for (const stmt of body) {
    if (!t.isExportNamedDeclaration(stmt) || !stmt.declaration || !t.isVariableDeclaration(stmt.declaration)) {
      out.push(stmt);
      continue;
    }

    const decl = stmt.declaration;
    const replaced: t.Statement[] = [];
    const remaining: t.VariableDeclarator[] = [];

    for (const d of decl.declarations) {
      if (!t.isIdentifier(d.id) || !actionNames.has(d.id.name)) {
        remaining.push(d);
        continue;
      }

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

      // registerAction(dbName, "X", { validator, handler })
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
    }

    if (replaced.length > 0) {
      if (remaining.length > 0) {
        out.push(t.exportNamedDeclaration(t.variableDeclaration(decl.kind, remaining)));
      }
      out.push(...replaced);
    } else {
      out.push(stmt);
    }
  }

  ast.program.body = out;
  return generateWithMap(ast, sourceFileName);
}
