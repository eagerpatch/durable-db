import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import type { NodePath } from '@babel/traverse';
import * as path from 'node:path';
import type { Alias } from 'vite';
import type { DatabaseInfo, ActionInfo, ParsedDatabaseFile } from '../../db';
import { debugVite } from '../../utils/debug';
import { applyAliases } from './aliasResolver';

/** Options for {@link parseDatabaseFile}. */
export interface ParseDatabaseFileOptions {
  /**
   * Resolved Vite `resolve.alias` entries, captured by the plugin in
   * `configResolved`. Used to recognize an `action` factory imported through an
   * alias (e.g. `import { action } from '@/databases/main'`). Omitted in the CLI
   * (which doesn't transform actions), where only relative imports are tracked.
   */
  aliases?: readonly Alias[];
}

// Handle both ESM and CJS module formats for Babel
const traverse = typeof _traverse === 'function' ? _traverse : (_traverse as any).default;
const generate = typeof _generate === 'function' ? _generate : (_generate as any).default;

/**
 * Shared Babel parser plugins used across all parsing in the Vite plugin.
 * Ensures consistent syntax support (TypeScript, JSX, decorators, etc.).
 */
export const BABEL_PARSER_PLUGINS: any[] = [
  'typescript',
  'jsx',
  'topLevelAwait',
  'decorators-legacy',
  'classProperties',
];

/**
 * Parse a TypeScript/JavaScript file into an AST
 */
export function parseCode(code: string): t.File {
  return parse(code, {
    sourceType: 'module',
    plugins: BABEL_PARSER_PLUGINS,
  });
}

/**
 * Generate source code from an AST node
 */
export function generateCode(node: t.Node): string {
  return generate(node).code;
}

/**
 * Find calls to other actions within a handler's source code
 * Returns the names of actions that are called
 *
 * @param source - Handler source code
 * @param knownActionNames - Set of action names to detect calls to
 * @param context - Optional source location for diagnostics (shown in warnings)
 */
export function findActionCallsInSource(
  source: string,
  knownActionNames: Set<string>,
  context?: { filePath?: string; actionName?: string }
): string[] {
  const calls: string[] = [];

  try {
    // Wrap the source so it's valid JS
    const ast = parse(`const __handler = ${source}`, {
      sourceType: 'module',
      plugins: BABEL_PARSER_PLUGINS,
    });

    traverse(ast, {
      CallExpression(nodePath: NodePath<t.CallExpression>) {
        // Look for direct calls: someAction({ ... }) or await someAction({ ... })
        if (t.isIdentifier(nodePath.node.callee)) {
          const name = nodePath.node.callee.name;
          if (knownActionNames.has(name) && !calls.includes(name)) {
            calls.push(name);
          }
        }
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const where = context?.filePath
      ? `${path.basename(context.filePath)}${context.actionName ? ` → ${context.actionName}` : ''}`
      : context?.actionName ?? 'handler';
    console.warn(
      `[durable-db] Could not parse ${where} for cross-action call detection — ` +
      `cross-DB calls inside this handler will not be transformed. ${message}`
    );
    debugVite('Failed to parse handler source for action call detection: %O', e);
  }

  return calls;
}

/**
 * Parse a database file and extract database/action information
 *
 * This uses clean AST traversal - no regexes
 */
export function parseDatabaseFile(
  filePath: string,
  code: string,
  options: ParseDatabaseFileOptions = {}
): ParsedDatabaseFile {
  const ast = parseCode(code);

  const result: ParsedDatabaseFile = {
    filePath,
    database: null,
    actions: [],
    localImports: new Map(),
  };

  // Track what variable name 'action' is bound to (from destructuring defineDatabase or import)
  let actionFnName: string | null = null;
  let currentDatabaseName = path.basename(filePath).replace(/\.(ts|js)$/, '');

  traverse(ast, {
    // Track imports for dependency resolution
    ImportDeclaration(nodePath: NodePath<t.ImportDeclaration>) {
      const source = nodePath.node.source.value;

      for (const specifier of nodePath.node.specifiers) {
        if (t.isImportSpecifier(specifier)) {
          const imported = t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
          const localName = specifier.local.name;
          
          result.localImports.set(localName, { source, imported });
          
          // If importing 'action' from the database's own file, track it as the
          // action factory. This handles:
          //   import { action } from '../main'           (relative)
          //   import { action as myAction } from '../db'  (relative, renamed)
          //   import { action } from '@/databases/main'   (Vite resolve.alias)
          // We accept relative imports, or Vite aliases that resolve to a real
          // file — but NOT bare npm package imports, so a genuine third-party
          // `action` export isn't mistaken for the factory. Aliases come from the
          // project's Vite config (captured by the plugin), not from re-parsing
          // tsconfig ourselves.
          if (
            imported === 'action' &&
            (source.startsWith('.') || applyAliases(source, options.aliases) !== null)
          ) {
            actionFnName = localName;
          }
        } else if (t.isImportDefaultSpecifier(specifier)) {
          result.localImports.set(specifier.local.name, { source, imported: 'default' });
        } else if (t.isImportNamespaceSpecifier(specifier)) {
          result.localImports.set(specifier.local.name, { source, imported: '*' });
        }
      }
    },

    // Find: const { action } = defineDatabase({ ... })
    // Or: export const myAction = action({ ... })
    VariableDeclarator(nodePath: NodePath<t.VariableDeclarator>) {
      const init = nodePath.node.init;
      const id = nodePath.node.id;

      // Check if this is a defineDatabase call
      if (isDefineDatabaseCall(init)) {
        const dbInfo = extractDatabaseInfo(nodePath, init, filePath, result.localImports);
        if (dbInfo) {
          result.database = dbInfo;
        }

        // Extract the action factory name from destructuring
        // id can be LVal which includes ObjectPattern
        if (t.isObjectPattern(id)) {
          actionFnName = extractActionFactoryName(id);
        }
      }

      // Check if this is an action() call - either from defineDatabase or from import
      if (actionFnName && isActionCall(init, actionFnName)) {
        const actionInfo = extractActionInfo(nodePath, init, currentDatabaseName, filePath);
        if (actionInfo) {
          result.actions.push(actionInfo);
        }
      }
    },
  });

  return result;
}

/**
 * Check if a node is a defineDatabase() call
 */
function isDefineDatabaseCall(node: t.Node | null | undefined): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    node.callee.name === 'defineDatabase'
  );
}

/**
 * Check if a node is an action() call with the given factory name
 */
function isActionCall(node: t.Node | null | undefined, actionFnName: string): node is t.CallExpression {
  return (
    t.isCallExpression(node) &&
    t.isIdentifier(node.callee) &&
    node.callee.name === actionFnName
  );
}

/**
 * Extract the 'action' variable name from destructuring pattern
 * const { action } = defineDatabase(...)
 *        ^^^^^^^
 */
function extractActionFactoryName(pattern: t.ObjectPattern): string | null {
  for (const prop of pattern.properties) {
    // Skip rest elements
    if (t.isRestElement(prop)) {
      continue;
    }

    if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.key.name === 'action') {
      // Handle both { action } and { action: renamedAction }
      if (t.isIdentifier(prop.value)) {
        return prop.value.name;
      }
      // Shorthand: { action } - key and value are the same
      return 'action';
    }
  }

  return null;
}

/**
 * Warn when a defineDatabase() config property uses a non-literal value
 * that can't be statically analyzed.
 */
function warnNonLiteral(filePath: string, key: string, defaultValue: string): void {
  console.warn(
    `[durable-db] '${key}' in defineDatabase() must be a static literal for build-time analysis. ` +
    `Got a dynamic expression in ${path.basename(filePath)} — defaulting to '${defaultValue}'.`
  );
}

/**
 * Extract database configuration from a defineDatabase() call
 */
function extractDatabaseInfo(
  declaratorPath: NodePath<t.VariableDeclarator>,
  callExpr: t.CallExpression,
  filePath: string,
  imports: Map<string, { source: string; imported: string }>
): DatabaseInfo | null {
  const configArg = callExpr.arguments[0];
  if (!t.isObjectExpression(configArg)) {
    return null;
  }

  // Default values
  let instance: 'per-tenant' | 'global' = 'per-tenant';
  let browsable: boolean | 'development' = false;
  let transport: 'rpc' | 'websocket' = 'rpc';
  let schemaImport: string | null = null;
  const schemaTableNames: string[] = [];

  for (const prop of configArg.properties) {
    if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) {
      continue;
    }

    const key = prop.key.name;

    if (key === 'instance') {
      if (t.isStringLiteral(prop.value)) {
        const value = prop.value.value;
        if (value === 'per-tenant' || value === 'global') {
          instance = value;
        }
      } else {
        warnNonLiteral(filePath, 'instance', 'per-tenant');
      }
    }

    if (key === 'browsable') {
      if (t.isBooleanLiteral(prop.value)) {
        browsable = prop.value.value;
      } else if (t.isStringLiteral(prop.value) && prop.value.value === 'development') {
        browsable = 'development';
      } else {
        warnNonLiteral(filePath, 'browsable', String(browsable));
      }
    }

    if (key === 'transport') {
      if (t.isStringLiteral(prop.value)) {
        const value = prop.value.value;
        if (value === 'rpc' || value === 'websocket') {
          transport = value;
        }
      } else {
        warnNonLiteral(filePath, 'transport', 'rpc');
      }
    }

    if (key === 'schema' && t.isObjectExpression(prop.value)) {
      // Extract schema table names and their import source
      for (const schemaProp of prop.value.properties) {
        if (t.isObjectProperty(schemaProp) || t.isSpreadElement(schemaProp)) {
          // For shorthand { users, posts }
          if (t.isObjectProperty(schemaProp) && t.isIdentifier(schemaProp.key)) {
            const tableName = schemaProp.key.name;
            schemaTableNames.push(tableName);

            // Track where the schema comes from
            const importInfo = imports.get(tableName);
            if (importInfo && !schemaImport) {
              schemaImport = importInfo.source;
            }
          }
        }
      }
    }
  }

  const name = path.basename(filePath).replace(/\.(ts|js)$/, '');

  return {
    filePath,
    name,
    className: toPascalCase(name) + 'DatabaseDO',
    bindingName: toScreamingSnakeCase(name) + '_DATABASE_DO',
    instance,
    browsable,
    transport,
    migrationsDir: '',
    schemaImport,
    schemaTableNames,
  };
}

/**
 * Extract action information from an action() call
 */
function extractActionInfo(
  declaratorPath: NodePath<t.VariableDeclarator>,
  callExpr: t.CallExpression,
  databaseName: string,
  filePath: string
): ActionInfo | null {
  // Get the export name from the variable declaration
  const id = declaratorPath.node.id;
  if (!t.isIdentifier(id)) {
    return null;
  }
  const exportName = id.name;

  // Get the config object
  const configArg = callExpr.arguments[0];
  if (!t.isObjectExpression(configArg)) {
    return null;
  }

  let argsSchemaSource = '{}';
  let handlerSource = 'async () => {}';

  for (const prop of configArg.properties) {
    if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) {
      continue;
    }

    const key = prop.key.name;

    if (key === 'args') {
      argsSchemaSource = generateCode(prop.value);
    }

    if (key === 'handler') {
      handlerSource = generateCode(prop.value);
    }
  }

  return {
    exportName,
    argsSchemaSource,
    handlerSource,
    databaseName,
    sourceFile: filePath,
  };
}

/**
 * Convert a string to PascalCase
 */
export function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Convert a string to SCREAMING_SNAKE_CASE
 */
export function toScreamingSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-]/g, '_')
    .toUpperCase();
}

