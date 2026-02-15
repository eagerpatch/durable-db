import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import type { NodePath } from '@babel/traverse';
import * as path from 'node:path';
import type { DatabaseInfo, ActionInfo, ParsedDatabaseFile } from '../../db';

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
 */
export function findActionCallsInSource(source: string, knownActionNames: Set<string>): string[] {
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
    console.warn('[shoplayer-database] Failed to parse handler source for action call detection:', e);
  }

  return calls;
}

/**
 * Parse a database file and extract database/action information
 *
 * This uses clean AST traversal - no regexes
 */
export function parseDatabaseFile(filePath: string, code: string): ParsedDatabaseFile {
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
          
          // If importing 'action' from a relative path, track it as the action factory
          // This handles: import { action } from '../main'
          // or: import { action as myAction } from '../database'
          if (imported === 'action' && source.startsWith('.')) {
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
  let migrationsDir = './migrations';
  let instance: 'per-shop' | 'global' = 'per-shop';
  let schemaImport: string | null = null;
  const schemaTableNames: string[] = [];

  for (const prop of configArg.properties) {
    if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) {
      continue;
    }

    const key = prop.key.name;

    if (key === 'migrationsDir' && t.isStringLiteral(prop.value)) {
      migrationsDir = prop.value.value;
    }

    if (key === 'instance' && t.isStringLiteral(prop.value)) {
      const value = prop.value.value;
      if (value === 'per-shop' || value === 'global') {
        instance = value;
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
    migrationsDir,
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

