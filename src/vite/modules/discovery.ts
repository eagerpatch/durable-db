import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Options for database discovery
 */
export interface DiscoveryOptions {
  /** Project root directory */
  projectRoot: string;
  /** Directory containing database definitions (relative to projectRoot) */
  databasesDir: string;
}

/**
 * Result of database discovery
 */
export interface DiscoveredFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to project root */
  relativePath: string;
  /** Database name (derived from filename without extension) */
  name: string;
}

/**
 * Discover database files in the configured directory
 *
 * Looks for .ts files in the databases directory, excluding:
 * - .d.ts files
 * - schema.ts (schema-only files)
 * - Files starting with _ (private helpers)
 */
export function discoverDatabaseFiles(options: DiscoveryOptions): DiscoveredFile[] {
  const { projectRoot, databasesDir } = options;
  const absoluteDir = path.join(projectRoot, databasesDir);

  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const files = fs.readdirSync(absoluteDir);
  const results: DiscoveredFile[] = [];

  for (const file of files) {
    // Skip non-TypeScript files
    if (!file.endsWith('.ts')) continue;

    // Skip declaration files
    if (file.endsWith('.d.ts')) continue;

    // Skip schema-only files
    if (file === 'schema.ts') continue;

    // Skip private helper files
    if (file.startsWith('_')) continue;

    const absolutePath = path.join(absoluteDir, file);
    const relativePath = path.join(databasesDir, file);
    const name = path.basename(file, '.ts');

    results.push({
      absolutePath,
      relativePath,
      name,
    });
  }

  return results;
}

/**
 * Resolve a relative import path to an absolute path
 *
 * Tries various extensions and index files
 */
export function resolveImportPath(
  fromFile: string,
  importSource: string
): string | null {
  // Only handle relative imports
  if (!importSource.startsWith('.')) {
    return null;
  }

  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, importSource);

  // Try exact path first (if already has extension)
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return resolved;
  }

  // Try common extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  for (const ext of extensions) {
    const withExt = resolved + ext;
    if (fs.existsSync(withExt)) {
      return withExt;
    }
  }

  // Try index files (for directory imports)
  const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
  for (const indexFile of indexFiles) {
    const indexPath = path.join(resolved, indexFile);
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Check if a file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Read file contents
 */
export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}
