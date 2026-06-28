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
// Constants
// ============================================================================

/**
 * Virtual module (served by the Vite plugin) exporting `applyDevEpoch(key)`.
 * In dev it suffixes instance keys with the current dev epoch so `db reset`
 * (which bumps the epoch) yields fresh DO instances; in production builds it
 * is the identity function.
 */
export const DEV_EPOCH_IMPORT = 'virtual:durable-db/__devEpoch';

// Local name for the arktype `type` we inject from the registry into a USER's action
// file. Aliased (not bare `type`) so it never clashes with the app's own
// `import { type } from '@shoplayer/framework'` — a duplicate top-level binding that
// rollup tolerated but rolldown (Vite 8+) rejects with "Identifier 'type' has already
// been declared". The injected import still routes to durable-db's inlined arktype
// instance (see the comment at the injection site).
const ARKTYPE_LOCAL = '__ddType';

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
  registryImport: string;
}

interface StubConfig {
  action: ActionInfo;
  database: DatabaseInfo;
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

// ============================================================================
// AST Builders - Imports
// ============================================================================

// An import name is either a bare name (local === imported) or an aliased pair.
// Aliasing matters when an injected import would otherwise clash with a name the
// user already has in scope — e.g. `type`, which apps import from their framework.
type ImportName = string | { imported: string; local: string };

function asImportName(n: ImportName): { imported: string; local: string } {
  return typeof n === 'string' ? { imported: n, local: n } : n;
}

function createNamedImport(names: ImportName[], source: string): t.ImportDeclaration {
  const specifiers = names.map((n) => {
    const { imported, local } = asImportName(n);
    return t.importSpecifier(t.identifier(local), t.identifier(imported));
  });
  return t.importDeclaration(specifiers, t.stringLiteral(source));
}

function ensureNamedImports(body: t.Statement[], source: string, names: ImportName[]): void {
  const existing = body.find(
    (s): s is t.ImportDeclaration => t.isImportDeclaration(s) && s.source.value === source
  );

  if (!existing) {
    let insertAt = 0;
    while (insertAt < body.length && t.isImportDeclaration(body[insertAt])) insertAt++;
    body.splice(insertAt, 0, createNamedImport(names, source));
    return;
  }

  // Dedupe by imported name so re-running over an already-transformed file is a no-op
  // (the local alias, if any, is preserved on the existing specifier).
  const have = new Set(
    existing.specifiers
    .filter((sp): sp is t.ImportSpecifier => t.isImportSpecifier(sp))
    .map((sp) => ((sp.imported as t.Identifier).name))
  );

  for (const n of names) {
    const { imported, local } = asImportName(n);
    if (!have.has(imported)) {
      existing.specifiers.push(t.importSpecifier(t.identifier(local), t.identifier(imported)));
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

function buildDbTransportsObject(databases: DatabaseInfo[]): t.ObjectExpression {
  const properties = databases.map((db) =>
    t.objectProperty(t.stringLiteral(db.name), t.stringLiteral(db.transport))
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
  registryImport: string,
  isDev: boolean = false
): string {
  const bindingNamesExpr = buildBindingNamesObject(databases);
  const dbTransportsExpr = buildDbTransportsObject(databases);
  const anyBrowsable = databases.some(
    (db) => db.browsable === true || (db.browsable === 'development' && isDev)
  );
  const anyWebSocket = databases.some((db) => db.transport === 'websocket');

  const imports: t.ImportDeclaration[] = [
    createNamedImport(['SqliteDurableObject', 'type'], 'durable-db/db'),
    createNamedImport(['getAction', 'runWithDoContext'], registryImport),
  ];

  if (anyBrowsable) {
    imports.push(createNamedImport(['Browsable'], '@outerbase/browsable-durable-object'));
  }

  if (anyWebSocket) {
    imports.push(
      createNamedImport(['decodeRequest', 'encodeResponse'], 'durable-db/transport/protocol')
    );
  }

  const statements: t.Statement[] = [...imports];
  for (const db of databases) {
    statements.push(...buildDurableObjectStatements(db, bindingNamesExpr, dbTransportsExpr, isDev));
  }

  const program = t.program(statements);
  return generateCode(t.file(program));
}

/**
 * Build an async method that calls this.ensureMigrations() then super.<name>(...args).
 */
function buildMigrationGuardMethod(
  name: string,
  params: t.Identifier[]
): t.ClassMethod {
  return t.classMethod(
    'method',
    t.identifier(name),
    params,
    t.blockStatement([
      // await this.ensureMigrations();
      t.expressionStatement(
        t.awaitExpression(
          t.callExpression(
            t.memberExpression(t.thisExpression(), t.identifier('ensureMigrations')),
            []
          )
        )
      ),
      // return super.<name>(...args);
      t.returnStatement(
        t.callExpression(
          t.memberExpression(t.super(), t.identifier(name)),
          params
        )
      ),
    ]),
    false, // computed
    false, // static
    false, // generator
    true   // async
  );
}

/**
 * Build statements for a single database's Durable Object class.
 *
 * When browsable is enabled, generates:
 *   const _ClassName_Base = Browsable()(class extends SqliteDurableObject { migrations = {...}; });
 *   export class ClassName extends _ClassName_Base {
 *     async fetch(req) { await this.ensureMigrations(); return super.fetch(req); }
 *     async __studio(cmd) { await this.ensureMigrations(); return super.__studio(cmd); }
 *     async rpc(...) { ... }
 *   }
 *
 * When not browsable:
 *   export class ClassName extends SqliteDurableObject {
 *     migrations = {...};
 *     async rpc(...) { ... }
 *   }
 */
function buildDurableObjectStatements(
  db: DatabaseInfo,
  bindingNamesExpr: t.ObjectExpression,
  dbTransportsExpr: t.ObjectExpression,
  isDev: boolean
): t.Statement[] {
  const isBrowsable = db.browsable === true || (db.browsable === 'development' && isDev);
  const rpcMethod = buildRpcMethod(db, bindingNamesExpr, dbTransportsExpr);
  const migrationsProperty = t.classProperty(
    t.identifier('migrations'),
    buildMigrationsObject(db.migrations)
  );

  const sysMethod = buildSysMethod();
  const classMethods: t.ClassMethod[] = [rpcMethod, sysMethod];

  // Add webSocketMessage handler when transport is websocket
  if (db.transport === 'websocket') {
    classMethods.push(buildWebSocketMessageMethod(db, bindingNamesExpr, dbTransportsExpr));
  }

  if (!isBrowsable) {
    const classDecl = t.classDeclaration(
      t.identifier(db.className),
      t.identifier('SqliteDurableObject'),
      t.classBody([migrationsProperty, ...classMethods])
    );
    return [t.exportNamedDeclaration(classDecl)];
  }

  // Browsable case
  const baseName = `_${db.className}_Base`;
  const innerClass = t.classExpression(
    null,
    t.identifier('SqliteDurableObject'),
    t.classBody([migrationsProperty])
  );
  const browsableWrapped = t.callExpression(
    t.callExpression(t.identifier('Browsable'), []),
    [innerClass]
  );
  const baseDecl = t.variableDeclaration('const', [
    t.variableDeclarator(t.identifier(baseName), browsableWrapped),
  ]);

  const classDecl = t.classDeclaration(
    t.identifier(db.className),
    t.identifier(baseName),
    t.classBody([
      buildMigrationGuardMethod('fetch', [t.identifier('request')]),
      buildMigrationGuardMethod('__studio', [t.identifier('cmd')]),
      ...classMethods,
    ])
  );

  return [baseDecl, t.exportNamedDeclaration(classDecl)];
}

/**
 * Build the ctx object expression used inside DO methods (rpc, webSocketMessage).
 */
function buildDoCtxObject(
  dbNameLiteral: t.StringLiteral,
  bindingNamesExpr: t.ObjectExpression,
  dbTransportsExpr: t.ObjectExpression,
  instanceKeyExpr: t.Expression
): t.ObjectExpression {
  return t.objectExpression([
    t.objectProperty(
      t.identifier('env'),
      t.memberExpression(t.thisExpression(), t.identifier('env'))
    ),
    t.objectProperty(t.identifier('dbName'), dbNameLiteral),
    t.objectProperty(t.identifier('dbBindingNames'), bindingNamesExpr),
    t.objectProperty(t.identifier('dbTransports'), dbTransportsExpr),
    t.objectProperty(t.identifier('instanceKey'), instanceKeyExpr),
  ]);
}

/**
 * Build the `sys(command)` method for system operations like destroyDatabase.
 *
 * Generates:
 *   async sys(command) {
 *     if (command === "destroyDatabase") {
 *       await this.ctx.storage.deleteAll();
 *       this.resetMigrationState();
 *       return null;
 *     }
 *     throw new Error(`[db] Unknown system command: "${command}"`);
 *   }
 */
function buildSysMethod(): t.ClassMethod {
  const body = t.blockStatement([
    // if (command === "destroyDatabase") { ... }
    t.ifStatement(
      t.binaryExpression(
        '===',
        t.identifier('command'),
        t.stringLiteral('destroyDatabase')
      ),
      t.blockStatement([
        // await this.ctx.storage.deleteAll();
        t.expressionStatement(
          t.awaitExpression(
            t.callExpression(
              t.memberExpression(
                t.memberExpression(
                  t.memberExpression(t.thisExpression(), t.identifier('ctx')),
                  t.identifier('storage')
                ),
                t.identifier('deleteAll')
              ),
              []
            )
          )
        ),
        // this.resetMigrationState();
        t.expressionStatement(
          t.callExpression(
            t.memberExpression(t.thisExpression(), t.identifier('resetMigrationState')),
            []
          )
        ),
        // return null;
        t.returnStatement(t.nullLiteral()),
      ])
    ),

    // throw new Error(`[db] Unknown system command: "${command}"`);
    t.throwStatement(
      t.newExpression(t.identifier('Error'), [
        t.templateLiteral(
          [
            t.templateElement({ raw: '[db] Unknown system command: "', cooked: '[db] Unknown system command: "' }, false),
            t.templateElement({ raw: '"', cooked: '"' }, true),
          ],
          [t.identifier('command')]
        ),
      ])
    ),
  ]);

  return t.classMethod(
    'method',
    t.identifier('sys'),
    [t.identifier('command')],
    body,
    false, // computed
    false, // static
    false, // generator
    true   // async
  );
}

function buildRpcMethod(
  db: DatabaseInfo,
  bindingNamesExpr: t.ObjectExpression,
  dbTransportsExpr: t.ObjectExpression
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
                t.templateElement({ raw: `[db] Unknown action "`, cooked: `[db] Unknown action "` }, false),
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
                t.templateElement({ raw: `[db] Invalid args for "`, cooked: `[db] Invalid args for "` }, false),
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

    // const ctx = { env: this.env, dbName: "...", dbBindingNames: {...}, dbTransports: {...}, instanceKey: ... };
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('ctx'),
        buildDoCtxObject(
          dbNameLiteral,
          bindingNamesExpr,
          dbTransportsExpr,
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

/**
 * Build the webSocketMessage method for WebSocket-enabled DOs.
 *
 * Generates:
 *   async webSocketMessage(ws, message) {
 *     await this.ensureMigrations();
 *     const request = decodeRequest(typeof message === "string" ? message : new TextDecoder().decode(message));
 *     const { id, action: method, args, instanceKey: reqInstanceKey } = request;
 *     try {
 *       const entry = getAction("dbName", method);
 *       if (!entry) { ws.send(encodeResponse({ id, ok: false, error: "Unknown action" })); return; }
 *       const validated = entry.validator(args);
 *       if (validated instanceof type.errors) { ws.send(encodeResponse({ id, ok: false, error: validated.summary })); return; }
 *       const ctx = { ... };
 *       const result = await runWithDoContext({ ... }, async () => entry.handler(this.db, validated, ctx));
 *       ws.send(encodeResponse({ id, ok: true, result }));
 *     } catch (error) {
 *       ws.send(encodeResponse({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
 *     }
 *   }
 */
function buildWebSocketMessageMethod(
  db: DatabaseInfo,
  bindingNamesExpr: t.ObjectExpression,
  dbTransportsExpr: t.ObjectExpression
): t.ClassMethod {
  const dbNameLiteral = t.stringLiteral(db.name);

  // Helper: ws.send(encodeResponse({ id, ok, ... }))
  function wsSendResponse(props: t.ObjectProperty[]): t.ExpressionStatement {
    return t.expressionStatement(
      t.callExpression(
        t.memberExpression(t.identifier('ws'), t.identifier('send')),
        [
          t.callExpression(t.identifier('encodeResponse'), [
            t.objectExpression(props),
          ]),
        ]
      )
    );
  }

  function errorResponseProps(errorExpr: t.Expression): t.ObjectProperty[] {
    return [
      t.objectProperty(t.identifier('id'), t.identifier('id')),
      t.objectProperty(t.identifier('ok'), t.booleanLiteral(false)),
      t.objectProperty(t.identifier('error'), errorExpr),
    ];
  }

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

    // const request = decodeRequest(typeof message === "string" ? message : new TextDecoder().decode(message));
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('request'),
        t.callExpression(t.identifier('decodeRequest'), [
          t.conditionalExpression(
            t.binaryExpression(
              '===',
              t.unaryExpression('typeof', t.identifier('message')),
              t.stringLiteral('string')
            ),
            t.identifier('message'),
            t.callExpression(
              t.memberExpression(
                t.newExpression(t.identifier('TextDecoder'), []),
                t.identifier('decode')
              ),
              [t.identifier('message')]
            )
          ),
        ])
      ),
    ]),

    // const { id, action: method, args, instanceKey: reqInstanceKey } = request;
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.objectPattern([
          t.objectProperty(t.identifier('id'), t.identifier('id'), false, true),
          t.objectProperty(t.identifier('action'), t.identifier('method')),
          t.objectProperty(t.identifier('args'), t.identifier('args'), false, true),
          t.objectProperty(t.identifier('instanceKey'), t.identifier('reqInstanceKey')),
        ]),
        t.identifier('request')
      ),
    ]),

    // try { ... } catch (error) { ... }
    t.tryStatement(
      t.blockStatement([
        // const entry = getAction("dbName", method);
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('entry'),
            t.callExpression(t.identifier('getAction'), [dbNameLiteral, t.identifier('method')])
          ),
        ]),

        // if (!entry) { ws.send(...); return; }
        t.ifStatement(
          t.unaryExpression('!', t.identifier('entry')),
          t.blockStatement([
            wsSendResponse(errorResponseProps(
              t.templateLiteral(
                [
                  t.templateElement({ raw: 'Unknown action: ', cooked: 'Unknown action: ' }, false),
                  t.templateElement({ raw: '', cooked: '' }, true),
                ],
                [t.identifier('method')]
              )
            )),
            t.returnStatement(null),
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

        // if (validated instanceof type.errors) { ws.send(...); return; }
        t.ifStatement(
          t.binaryExpression(
            'instanceof',
            t.identifier('validated'),
            t.memberExpression(t.identifier('type'), t.identifier('errors'))
          ),
          t.blockStatement([
            wsSendResponse(errorResponseProps(
              t.memberExpression(t.identifier('validated'), t.identifier('summary'))
            )),
            t.returnStatement(null),
          ])
        ),

        // const ctx = { ... };
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('ctx'),
            buildDoCtxObject(
              dbNameLiteral,
              bindingNamesExpr,
              dbTransportsExpr,
              t.logicalExpression(
                '??',
                t.identifier('reqInstanceKey'),
                t.stringLiteral('global')
              )
            )
          ),
        ]),

        // const result = await runWithDoContext({ ... }, async () => entry.handler(this.db, validated, ctx));
        t.variableDeclaration('const', [
          t.variableDeclarator(
            t.identifier('result'),
            t.awaitExpression(
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
                  true
                ),
              ])
            )
          ),
        ]),

        // ws.send(encodeResponse({ id, ok: true, result }));
        wsSendResponse([
          t.objectProperty(t.identifier('id'), t.identifier('id'), false, true),
          t.objectProperty(t.identifier('ok'), t.booleanLiteral(true)),
          t.objectProperty(t.identifier('result'), t.identifier('result'), false, true),
        ]),
      ]),
      t.catchClause(
        t.identifier('error'),
        t.blockStatement([
          // ws.send(encodeResponse({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
          wsSendResponse(errorResponseProps(
            t.conditionalExpression(
              t.binaryExpression(
                'instanceof',
                t.identifier('error'),
                t.identifier('Error')
              ),
              t.memberExpression(t.identifier('error'), t.identifier('message')),
              t.callExpression(t.identifier('String'), [t.identifier('error')])
            )
          )),
        ])
      )
    ),
  ]);

  return t.classMethod(
    'method',
    t.identifier('webSocketMessage'),
    [t.identifier('ws'), t.identifier('message')],
    body,
    false,
    false,
    false,
    true // async
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

  // if (__do && __do.dbName === "dbName") { return callAction(...) }
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
        t.callExpression(t.identifier('callAction'), [
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

/**
 * Build `applyDevEpoch(<baseKey>)` — instance keys always pass through the
 * dev-epoch helper so `db reset` can rotate to fresh DO instances in dev.
 */
function buildInstanceKeyExpr(database: DatabaseInfo): t.CallExpression {
  const baseKeyExpr =
    database.instance === 'global'
      ? t.stringLiteral('global')
      : t.callExpression(t.identifier('getTenantId'), []);

  return t.callExpression(t.identifier('applyDevEpoch'), [baseKeyExpr]);
}

function buildStubBodyStatements(config: StubConfig): t.Statement[] {
  const { action, database } = config;

  const bindingExpr = t.memberExpression(t.identifier('env'), t.identifier(database.bindingName));
  const instanceKeyExpr = buildInstanceKeyExpr(database);

  const commonStatements: t.Statement[] = [
    // const argsSchema = __ddType({...});
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('argsSchema'),
        t.callExpression(t.identifier(ARKTYPE_LOCAL), [parseExpression(action.argsSchemaSource)])
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
  ];

  if (database.transport === 'websocket') {
    return [
      ...commonStatements,
      // const wsTransport = new WebSocketTransport(stub);
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('wsTransport'),
          t.newExpression(t.identifier('WebSocketTransport'), [t.identifier('stub')])
        ),
      ]),
      // return wsTransport.call("actionName", validatedArgs, instanceKey);
      t.returnStatement(
        t.callExpression(
          t.memberExpression(t.identifier('wsTransport'), t.identifier('call')),
          [
            t.stringLiteral(action.exportName),
            t.identifier('validatedArgs'),
            t.identifier('instanceKey'),
          ]
        )
      ),
    ];
  }

  return [
    ...commonStatements,
    // return stub.rpc(...)
    t.returnStatement(buildRpcCall(action)),
  ];
}

// ============================================================================
// Action Transform (shared by action files and database definition files)
// ============================================================================

interface ActionTransformContext {
  dbName: string;
  database: DatabaseInfo;
  actionsInFile: ActionInfo[];
  contextImport: string;
  registryImport: string;
}

/**
 * Rewrite `export const x = action({...})` declarations in the given program
 * body into validator + handler registration + RPC stub. Mutates `body` in
 * place. Returns whether any transformation was applied.
 */
function applyActionTransforms(body: t.Statement[], ctx: ActionTransformContext): boolean {
  const { dbName, database, actionsInFile, contextImport, registryImport } = ctx;

  if (actionsInFile.length === 0) return false;

  ensureNamedImports(body, contextImport, ['getTenantId']);
  ensureNamedImports(body, 'cloudflare:workers', ['env']);
  // `type` comes from the registry subpath (which re-exports arktype's `type`),
  // NOT bare `arktype`: the latter isn't hoisted to a pnpm app's root, so the
  // injected import fails to resolve in the cloudflare plugin's worker-entry
  // evaluation. registryImport always resolves there (it's already injected),
  // and routes to durable-db's single inlined arktype instance. Imported under an
  // alias (ARKTYPE_LOCAL) so it never collides with the app's own `type` import.
  ensureNamedImports(body, registryImport, [
    'registerAction',
    'getDoContext',
    'callAction',
    { imported: 'type', local: ARKTYPE_LOCAL },
  ]);
  ensureNamedImports(body, DEV_EPOCH_IMPORT, ['applyDevEpoch']);

  if (database.transport === 'websocket') {
    ensureNamedImports(body, 'durable-db/transport/websocket', ['WebSocketTransport']);
  }

  const actionNames = new Set(actionsInFile.map((a) => a.exportName));
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

      // const __validator_X = __ddType(<schema>);
      replaced.push(
        t.variableDeclaration('const', [
          t.variableDeclarator(
            validatorId,
            t.callExpression(t.identifier(ARKTYPE_LOCAL), [parseExpression(action.argsSchemaSource)])
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
        t.blockStatement(buildStubBodyStatements({ action, database })),
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

  body.splice(0, body.length, ...out);
  return true;
}

// ============================================================================
// Action File Transform
// ============================================================================

export function transformActionFile(options: TransformOptions) {
  const { code, sourceFileName, ...ctx } = options;

  if (ctx.actionsInFile.length === 0) return null;

  const ast = parseProgram(code);
  applyActionTransforms(ast.program.body, ctx);

  return generateWithMap(ast, sourceFileName);
}

// ============================================================================
// Database Definition File Transform (destroyDatabase + same-file actions)
// ============================================================================

export interface TransformDatabaseFileOptions {
  code: string;
  sourceFileName?: string;
  database: DatabaseInfo;
  contextImport: string;
  /** `action()` definitions that live in the database file itself. */
  actionsInFile?: ActionInfo[];
  registryImport?: string;
}

/**
 * Transform a database definition file:
 * - replaces the `destroyDatabase` placeholder (when destructured) with a
 *   generated stub that calls the DO's `sys("destroyDatabase")` method
 * - rewrites same-file `action()` definitions into RPC stubs, exactly like
 *   action files that import the factory — without this, same-file actions
 *   pass discovery but throw "called without transformation" at runtime
 *
 * Returns null when there is nothing to transform.
 */
export function transformDatabaseFile(options: TransformDatabaseFileOptions) {
  const {
    code,
    sourceFileName,
    database,
    contextImport,
    actionsInFile = [],
    registryImport = 'durable-db/registry',
  } = options;

  const ast = parseProgram(code);
  const body = ast.program.body;

  const destroyTransformed = applyDestroyDatabaseTransform(body, database, contextImport);
  const actionsTransformed = applyActionTransforms(body, {
    dbName: database.name,
    database,
    actionsInFile,
    contextImport,
    registryImport,
  });

  if (!destroyTransformed && !actionsTransformed) return null;

  return generateWithMap(ast, sourceFileName);
}

/**
 * Replace a destructured `destroyDatabase` with a generated stub.
 * Mutates `body` in place. Returns whether the transform was applied.
 */
function applyDestroyDatabaseTransform(
  body: t.Statement[],
  database: DatabaseInfo,
  contextImport: string
): boolean {
  // Find the `export const { action, destroyDatabase } = defineDatabase(...)` pattern
  let found = false;

  for (const stmt of body) {
    if (!t.isExportNamedDeclaration(stmt) || !stmt.declaration || !t.isVariableDeclaration(stmt.declaration)) {
      continue;
    }

    for (const decl of stmt.declaration.declarations) {
      if (!t.isObjectPattern(decl.id) || !isDefineDatabaseCallNode(decl.init)) {
        continue;
      }

      // Check if destroyDatabase is in the destructuring pattern
      const destroyIdx = decl.id.properties.findIndex(
        (prop) =>
          t.isObjectProperty(prop) &&
          t.isIdentifier(prop.key) &&
          prop.key.name === 'destroyDatabase'
      );

      if (destroyIdx === -1) continue;

      // Remove destroyDatabase from the destructuring pattern
      decl.id.properties.splice(destroyIdx, 1);
      found = true;
    }
  }

  if (!found) return false;

  // Add required imports
  ensureNamedImports(body, 'cloudflare:workers', ['env']);
  ensureNamedImports(body, DEV_EPOCH_IMPORT, ['applyDevEpoch']);
  if (database.instance === 'per-tenant') {
    ensureNamedImports(body, contextImport, ['getTenantId']);
  }

  // Build the destroyDatabase stub function
  const bindingExpr = t.memberExpression(t.identifier('env'), t.identifier(database.bindingName));
  const instanceKeyExpr = buildInstanceKeyExpr(database);

  const stubBody = t.blockStatement([
    // const instanceKey = getTenantId() or "global"
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

    // return stub.sys("destroyDatabase");
    t.returnStatement(
      t.callExpression(
        t.memberExpression(t.identifier('stub'), t.identifier('sys')),
        [t.stringLiteral('destroyDatabase')]
      )
    ),
  ]);

  const funcDecl = t.functionDeclaration(
    t.identifier('destroyDatabase'),
    [],
    stubBody,
    false, // generator
    true   // async
  );

  body.push(t.exportNamedDeclaration(funcDecl));

  return true;
}

function isDefineDatabaseCallNode(node: t.Node | null | undefined): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    node.callee.name === 'defineDatabase'
  );
}
