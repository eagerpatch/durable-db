import type { DatabaseInfo, ActionInfo } from '../../db';

import * as t from '@babel/types';
import _generate from '@babel/generator';
import { parse } from '@babel/parser';

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

function parseMemberPath(base: t.Expression, path: string): t.Expression {
  return path.split('.').reduce<t.Expression>(
    (obj, prop) => t.memberExpression(obj, t.identifier(prop)),
    base
  );
}

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

function generateWithMap(ast: t.File, sourceFileName?: string): { code: string; map: any } {
  const out = generate(ast, { sourceMaps: true, sourceFileName, comments: true });
  return { code: out.code, map: out.map as any };
}

// ============================================================================
// Durable Objects Module Generation
// ============================================================================

export function generateDurableObjectsModule(
  databases: DatabaseInfo[],
  registryImport: string
): string {
  const bindingNames = Object.fromEntries(databases.map((db) => [db.name, db.bindingName]));
  const bindingNamesJson = JSON.stringify(bindingNames);

  const classes = databases.map((db) => {
    const migrationsJson = generateMigrationsJson(db.migrations);

    return `
export class ${db.className} extends SqliteDurableObject {
  migrations = ${migrationsJson};

  async rpc(method, args, rpcContext) {
    await this.ensureMigrations();

    const entry = getAction(${JSON.stringify(db.name)}, method);
    if (!entry) {
      throw new Error(\`[shoplayer-database] Unknown action "\${method}" for db "${db.name}" (was it imported?)\`);
    }

    const validated = entry.validator(args);
    if (validated instanceof type.errors) {
      throw new Error(\`[shoplayer-database] Invalid args for "\${method}": \${validated.summary}\`);
    }

    const ctx = {
      env: this.env,
      dbName: ${JSON.stringify(db.name)},
      dbBindingNames: ${bindingNamesJson},
      instanceKey: rpcContext?.instanceKey ?? 'global',
    };

    return runWithDoContext(
      { db: this.db, ctx, dbName: ${JSON.stringify(db.name)}, instanceKey: ctx.instanceKey },
      async () => entry.handler(this.db, validated, ctx)
    );
  }
}`;
  });

  return `
import { SqliteDurableObject } from '@shoplayer/database/db';
import { type } from 'arktype';
import { getAction, runWithDoContext } from '${registryImport}';
${classes.join('\n')}
`.trim();
}

function generateMigrationsJson(migrations?: Map<string, string[][]>): string {
  if (!migrations || migrations.size === 0) return '{}';

  const sorted = Array.from(migrations.entries()).sort(([a], [b]) => a.localeCompare(b));
  const entries = sorted.map(([name, chunks]) => `${JSON.stringify(name)}: { chunks: ${JSON.stringify(chunks)} }`);

  return `{ ${entries.join(', ')} }`;
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

  const doDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      t.identifier('__do'),
      t.callExpression(t.identifier('getDoContext'), [])
    ),
  ]);

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

export function transformActionFile(options: TransformOptions): { code: string; map: any } | null {
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
