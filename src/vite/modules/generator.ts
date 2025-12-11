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
export function buildRpcCall(config: StubConfig): t.CallExpression {
  const { action, database, shopIdPath } = config;
  const hasCrossDbCalls = action.crossDbActionCalls.length > 0;

  const methodCall = t.memberExpression(
    t.identifier('stub'),
    t.identifier(action.exportName)
  );

  if (!hasCrossDbCalls) {
    return t.callExpression(methodCall, [t.identifier('validatedArgs')]);
  }

  const instanceKey = database.instance === 'global'
    ? t.stringLiteral('global')
    : parseMemberPath(t.identifier('ctx'), shopIdPath);

  const optionsObj = t.objectExpression([
    t.objectProperty(t.identifier('instanceKey'), instanceKey)
  ]);

  return t.callExpression(methodCall, [t.identifier('validatedArgs'), optionsObj]);
}

/** Build a stub function body as statements */
export function buildStubBodyStatements(config: StubConfig): t.Statement[] {
  const { action, database, shopIdPath } = config;

  return [
    // const argsSchema = type({...});
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('argsSchema'),
        t.callExpression(t.identifier('type'), [parseExpression(action.argsSchemaSource)])
      )
    ]),
    // const validatedArgs = argsSchema.assert(args);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('validatedArgs'),
        t.callExpression(
          t.memberExpression(t.identifier('argsSchema'), t.identifier('assert')),
          [t.identifier('args')]
        )
      )
    ]),
    // const ctx = getContext();
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('ctx'),
        t.callExpression(t.identifier('getContext'), [])
      )
    ]),
    // const env = ctx.env;
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('env'),
        t.memberExpression(t.identifier('ctx'), t.identifier('env'))
      )
    ]),
    // const id = env.BINDING.idFromName(...);
    t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier('id'), buildIdStrategy(database, shopIdPath))
    ]),
    // const stub = env.BINDING.get(id);
    t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('stub'),
        t.callExpression(
          t.memberExpression(
            t.memberExpression(t.identifier('env'), t.identifier(database.bindingName)),
            t.identifier('get')
          ),
          [t.identifier('id')]
        )
      )
    ]),
    // return stub.actionName(validatedArgs, ...);
    t.returnStatement(buildRpcCall(config))
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
export function transformHandler(action: ActionInfo, crossDbContext: CrossDbContext): string {
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
// Cross-DB Context Builder
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
// Public API
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

/**
 * Generate the module that re-exports actions from the virtual module
 */
export function generateReExportModule(
  databaseName: string,
  actions: ActionInfo[]
): string {
  if (actions.length === 0) {
    return `// No actions to re-export`;
  }

  return generateFromStatements([
    createReExport(actions.map(a => a.exportName), `shoplayer/databases/${databaseName}`)
  ]);
}
