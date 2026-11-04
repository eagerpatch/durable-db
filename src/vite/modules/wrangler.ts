import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type JSONPath,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';
import type { DatabaseInfo } from '../../db';
import { debugVite } from '../../utils/debug';
import { toPascalCase } from './parser';

/** A Durable Object binding as wrangler.jsonc declares it. */
export interface DurableObjectBinding {
  name: string;
  class_name: string;
}

/** A class rename written as a `renamed_classes` migration. */
export interface ClassRename {
  from: string;
  to: string;
}

/**
 * A database's migrations directory moved with its class rename: the renamed
 * Durable Object keeps the old database's tables and `__migrations` journal,
 * so the build must embed the migrations that journal names.
 */
export interface MigrationsMove {
  /** The old database's migrations directory (absolute). */
  from: string;
  /** The renamed database's migrations directory (absolute). */
  to: string;
}

/**
 * A stale class and a new database that look like the same database under a
 * new mount, whose rename is not written: moving the data would leave it
 * without the migrations its journal names, or the old migrations directory
 * is not unique. Neither the rename nor a new class is written for the pair
 * until the user resolves it (the warning says how).
 */
export interface RenameConflict extends ClassRename {
  reason: string;
}

/**
 * Result of wrangler config patching
 */
export interface PatchResult {
  /** Whether the config was modified */
  modified: boolean;
  /** Path to the config file (if found) */
  configPath: string | null;
  /** Any errors that occurred */
  error: Error | null;
  /** Bindings added for discovered databases. */
  addedBindings: DurableObjectBinding[];
  /**
   * durable-db's own bindings (`<X>_DATABASE_DO` → `<X>DatabaseDO`) removed
   * because their class is no longer a discovered database (the worker
   * exports it only as a tombstone, see {@link tombstoneClasses}).
   */
  removedBindings: DurableObjectBinding[];
  /** Classes added to a `new_sqlite_classes` migration. */
  newClasses: string[];
  /** The tag of the migration written for `newClasses` and `renamedClasses`, if any. */
  migrationTag: string | null;
  /**
   * Classes renamed by a `renamed_classes` migration: a database of a mounted
   * source whose class name changed (its mount changed, or it moved into a
   * mounted source) keeps its deployed data.
   */
  renamedClasses: ClassRename[];
  /** Migrations directories moved with a rename (see {@link MigrationsMove}). */
  movedMigrations: MigrationsMove[];
  /**
   * Renames refused: written neither as a rename nor as a new class until the
   * user resolves them (see {@link RenameConflict}). A production build should
   * fail on them.
   */
  conflicts: RenameConflict[];
  /**
   * Classes of databases that are gone, still declared by the migrations.
   * Deleting a class deletes its data, so the `deleted_classes` migration is
   * never written automatically: the worker exports a tombstone of the class
   * ({@link tombstoneClasses}) and a note gives the exact entry to add.
   */
  deletedClasses: string[];
}

/**
 * Wrangler config structure (partial)
 */
interface WranglerConfig {
  durable_objects?: {
    bindings?: Array<{
      name: string;
      class_name: string;
      script_name?: string;
      environment?: string;
    }>;
  };
  migrations?: WranglerMigration[];
  [key: string]: unknown;
}

interface WranglerMigration {
  tag: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  renamed_classes?: ClassRename[];
  transferred_classes?: Array<{ from: string; from_script: string; to: string }>;
  deleted_classes?: string[];
}

/**
 * Find the wrangler config file in a project
 */
export function findWranglerConfig(projectRoot: string): string | null {
  const candidates = ['wrangler.jsonc', 'wrangler.json'];

  for (const candidate of candidates) {
    const configPath = path.join(projectRoot, candidate);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

/**
 * Strip JSONC comments while respecting string literals.
 * Tracks whether we're inside a `"..."` so `//` and `/*` inside
 * strings (e.g. URLs) are preserved.
 */
export function stripJsoncComments(content: string): string {
  let result = '';
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    // String literal — copy verbatim until the closing quote
    if (ch === '"') {
      result += '"';
      i++;
      while (i < len) {
        const sc = content[i];
        result += sc;
        i++;
        if (sc === '\\') {
          // escaped character — copy next char unconditionally
          if (i < len) {
            result += content[i];
            i++;
          }
        } else if (sc === '"') {
          break;
        }
      }
      continue;
    }

    // Single-line comment
    if (ch === '/' && i + 1 < len && content[i + 1] === '/') {
      // Skip until end of line
      i += 2;
      while (i < len && content[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && i + 1 < len && content[i + 1] === '*') {
      i += 2;
      while (i < len) {
        if (content[i] === '*' && i + 1 < len && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Parse wrangler.jsonc content: comments and trailing commas allowed, as
 * wrangler allows them. Throws on a syntax error.
 */
export function parseWranglerConfig(content: string): WranglerConfig {
  const errors: ParseError[] = [];
  const config = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    throw new SyntaxError(`Invalid wrangler config: ${printParseErrorCode(error)} at offset ${offset}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new SyntaxError('Invalid wrangler config: the top level is not an object');
  }
  return config as WranglerConfig;
}

// ---------------------------------------------------------------------------
// Ownership: which bindings and classes are durable-db's
// ---------------------------------------------------------------------------

const CLASS_SUFFIX = 'DatabaseDO';
const BINDING_SUFFIX = '_DATABASE_DO';

/**
 * Whether a binding follows durable-db's naming — class `<Pascal>DatabaseDO`,
 * binding `<SCREAMING_SNAKE>_DATABASE_DO` of the same database name — and
 * binds a class of this worker (no `script_name`). Only these are reconciled;
 * every other binding is the user's.
 */
function isDurableDbBinding(binding: { name: string; class_name: string; script_name?: string }): boolean {
  if (binding.script_name) return false;
  if (!isDurableDbClassName(binding.class_name) || !binding.name.endsWith(BINDING_SUFFIX)) return false;
  const classStem = binding.class_name.slice(0, -CLASS_SUFFIX.length);
  const bindingStem = binding.name.slice(0, -BINDING_SUFFIX.length);
  return bindingStem.length > 0 && bindingStem.replace(/_/g, '') === classStem.toUpperCase();
}

function isDurableDbClassName(className: string): boolean {
  return /^[A-Z][A-Za-z0-9]*DatabaseDO$/.test(className) && className.length > CLASS_SUFFIX.length;
}

/**
 * The classes the migrations declare and have not deleted, walked in order:
 * created (`new_classes`, `new_sqlite_classes`, `transferred_classes`),
 * renamed, deleted.
 */
function declaredClasses(migrations: unknown): Set<string> {
  const declared = new Set<string>();
  if (!Array.isArray(migrations)) return declared;
  for (const migration of migrations as WranglerMigration[]) {
    if (migration === null || typeof migration !== 'object') continue;
    const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
    for (const c of list(migration.new_classes)) declared.add(c);
    for (const c of list(migration.new_sqlite_classes)) declared.add(c);
    for (const r of list(migration.renamed_classes)) {
      if (r === null || typeof r !== 'object') continue;
      declared.delete(r.from);
      declared.add(r.to);
    }
    for (const t of list(migration.transferred_classes)) if (t && typeof t === 'object') declared.add(t.to);
    for (const c of list(migration.deleted_classes)) declared.delete(c);
  }
  return declared;
}

/** The database's file name without its extension: its name without a source's prefix. */
function fileStem(db: DatabaseInfo): string {
  return path.basename(db.filePath).replace(/\.(ts|js)$/, '');
}

/** The class a database would have without its source's prefix (`feedback` → `FeedbackDatabaseDO`). */
function unprefixedClassName(db: DatabaseInfo): string {
  return toPascalCase(fileStem(db)) + CLASS_SUFFIX;
}

/** Whether the database comes from a mounted source (`<prefix>-<file>`). */
function isPrefixed(db: DatabaseInfo): boolean {
  return db.name !== fileStem(db);
}

/**
 * The migrations directories, next to `db`'s own, of the database whose class
 * is `className` — every subdirectory whose name gives that class
 * (`reviews-feedback` → `ReviewsFeedbackDatabaseDO`). Exact: no name is
 * guessed, and more than one match is the caller's to refuse. Empty when `db`
 * has no migrations directory configured or none matches.
 */
function migrationsDirsOfClass(db: DatabaseInfo, className: string): string[] {
  if (!db.migrationsDir) return [];
  const root = path.dirname(db.migrationsDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && toPascalCase(entry.name) + CLASS_SUFFIX === className)
    .map((entry) => path.join(root, entry.name))
    .sort();
}

/** Whether `dir` exists with anything in it. */
function hasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** The next free `v<N>` tag. */
function nextTag(migrations: unknown): string {
  const numbers = (Array.isArray(migrations) ? migrations : []).map((m) => {
    const match = /^v(\d+)$/.exec(typeof m?.tag === 'string' ? m.tag : '');
    return match ? parseInt(match[1], 10) : 0;
  });
  return `v${numbers.length > 0 ? Math.max(...numbers) + 1 : 1}`;
}

/** A class durable-db keeps as a tombstone (see {@link tombstoneClasses}). */
export interface TombstoneClass {
  className: string;
  /** The migration that deletes the class — and all its data — for good. */
  deleteMigration: { tag: string; deleted_classes: string[] };
}

/**
 * The classes of removed databases the worker must still export: of
 * durable-db's naming, declared live by wrangler.jsonc's migrations (created
 * or renamed to, and not deleted or renamed away since), defined by none of
 * `databases`. @cloudflare/vite-plugin wraps every class the config names and
 * Cloudflare refuses a deploy that drops a class with data, but only a
 * `deleted_classes` migration drops one — deleting its data, which durable-db
 * never decides for the user. So the generated module exports a tombstone of
 * each (`RemovedDatabaseDurableObject`): storage untouched, every call
 * refused. Read like the reconciliation reads the config: wrangler.jsonc/json
 * only; none when there is no such file or it does not parse.
 */
export function tombstoneClasses(projectRoot: string, databases: DatabaseInfo[]): TombstoneClass[] {
  const configPath = findWranglerConfig(projectRoot);
  if (!configPath) return [];
  let config: WranglerConfig;
  try {
    config = parseWranglerConfig(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    debugVite('Failed to parse wrangler config for tombstones: %O', error);
    return [];
  }
  const discovered = new Set(databases.map((db) => db.className));
  const tag = nextTag(config.migrations);
  return [...declaredClasses(config.migrations)]
    .filter((className) => isDurableDbClassName(className) && !discovered.has(className))
    .map((className) => ({ className, deleteMigration: { tag, deleted_classes: [className] } }));
}

interface Reconciliation {
  addBindings: DurableObjectBinding[];
  /** Indexes into durable_objects.bindings. */
  removeBindingIndexes: number[];
  removedBindings: DurableObjectBinding[];
  newClasses: string[];
  renamedClasses: ClassRename[];
  /** The migrations directory each rename needs moved, by the class it renames to. */
  migrationsMoves: Map<string, MigrationsMove>;
  conflicts: RenameConflict[];
  deletedClasses: string[];
}

/**
 * What it takes for the config to match the discovered databases: bindings to
 * add and remove, classes to create and rename, and classes of removed
 * databases that only a hand-written `deleted_classes` migration can drop.
 */
function reconcile(config: WranglerConfig, databases: DatabaseInfo[]): Reconciliation {
  // Indexes below are positions in the file's array: malformed entries are
  // skipped, not filtered out.
  const rawBindings: unknown[] = Array.isArray(config.durable_objects?.bindings)
    ? config.durable_objects.bindings
    : [];
  const isBinding = (b: unknown): b is NonNullable<NonNullable<WranglerConfig['durable_objects']>['bindings']>[number] =>
    b !== null && typeof b === 'object' &&
    typeof (b as { name?: unknown }).name === 'string' &&
    typeof (b as { class_name?: unknown }).class_name === 'string';
  const migrations = (Array.isArray(config.migrations) ? config.migrations : [])
    .filter((m): m is WranglerMigration => m !== null && typeof m === 'object');
  const discoveredClasses = new Set(databases.map((db) => db.className));

  // Bindings: durable-db's own whose class is no longer discovered go.
  const removeBindingIndexes: number[] = [];
  const removedBindings: DurableObjectBinding[] = [];
  rawBindings.forEach((binding, index) => {
    if (isBinding(binding) && isDurableDbBinding(binding) && !discoveredClasses.has(binding.class_name)) {
      removeBindingIndexes.push(index);
      removedBindings.push({ name: binding.name, class_name: binding.class_name });
    }
  });
  const remaining = rawBindings.filter(
    (binding, index): binding is DurableObjectBinding => isBinding(binding) && !removeBindingIndexes.includes(index)
  );

  // A binding counts as present when its name or its class matches (a user
  // may bind a database's class under a name of their own).
  const addBindings = databases
    .filter((db) => !remaining.some((b) => b.name === db.bindingName || b.class_name === db.className))
    .map((db) => ({ name: db.bindingName, class_name: db.className }));

  // Classes: declared ones of durable-db's naming that are neither discovered
  // nor bound by a remaining binding are stale.
  const declared = declaredClasses(migrations);
  const boundClasses = new Set(remaining.map((b) => b.class_name));
  const stale = [...declared].filter(
    (c) => isDurableDbClassName(c) && !discoveredClasses.has(c) && !boundClasses.has(c)
  );
  const missing = databases.filter((db) => !declared.has(db.className));

  // A stale class and a missing database are the same database under a new
  // mount when the database comes from a mounted source, its file name is the
  // one the stale class ends with (`ReviewsFeedbackDatabaseDO` →
  // `FeedbackFeedbackDatabaseDO` after a mount change; `FeedbackDatabaseDO` →
  // `ReviewsFeedbackDatabaseDO` for a database moved into a mounted source),
  // and each is the other's only candidate. A database of an unprefixed source
  // is never paired: `ProductCatalogDatabaseDO` → `CatalogDatabaseDO` (a
  // database moved out of a mount) reads exactly like an app replacing
  // product-catalog.ts with catalog.ts, and a wrong pairing hands one
  // database's data to another.
  const candidatesOf = (staleClass: string) =>
    missing.filter(
      (db) => isPrefixed(db) && staleClass !== db.className && staleClass.endsWith(unprefixedClassName(db))
    );
  const renamedClasses: ClassRename[] = [];
  const migrationsMoves = new Map<string, MigrationsMove>();
  const conflicts: RenameConflict[] = [];
  for (const staleClass of stale) {
    const candidates = candidatesOf(staleClass);
    if (candidates.length !== 1) continue;
    const [db] = candidates;
    const rivals = stale.filter((other) => candidatesOf(other).includes(db));
    if (rivals.length !== 1) continue;

    // The renamed Durable Object keeps the old storage — its tables and its
    // `__migrations` journal — so the old database's migrations move with it.
    // Without an old migrations directory nothing was ever deployed with
    // tables (production builds embed only those migrations): the rename
    // carries no data and needs no move.
    const rename = { from: staleClass, to: db.className };
    const oldDirs = migrationsDirsOfClass(db, staleClass);
    if (oldDirs.length > 1) {
      conflicts.push({
        ...rename,
        reason: `several migrations directories belong to ${staleClass}: ${oldDirs.join(', ')}`,
      });
    } else if (oldDirs.length === 1 && hasEntries(db.migrationsDir)) {
      conflicts.push({
        ...rename,
        reason: `both ${oldDirs[0]} and ${db.migrationsDir} exist`,
      });
    } else {
      renamedClasses.push(rename);
      if (oldDirs.length === 1) migrationsMoves.set(db.className, { from: oldDirs[0], to: db.migrationsDir });
    }
  }

  const renamedTo = new Set(renamedClasses.map((r) => r.to));
  const renamedFrom = new Set(renamedClasses.map((r) => r.from));
  const conflictTo = new Set(conflicts.map((c) => c.to));
  const conflictFrom = new Set(conflicts.map((c) => c.from));

  return {
    addBindings,
    removeBindingIndexes,
    removedBindings,
    newClasses: missing.map((db) => db.className).filter((c) => !renamedTo.has(c) && !conflictTo.has(c)),
    renamedClasses,
    migrationsMoves,
    conflicts,
    deletedClasses: stale.filter((c) => !renamedFrom.has(c) && !conflictFrom.has(c)),
  };
}

/** `dir` relative to the project root, for messages and commands. */
function relativeDir(projectRoot: string, dir: string): string {
  const relative = path.relative(projectRoot, dir);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : dir;
}

/** A path as one shell word. */
function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The warning for a rename refused, with both ways out. */
function renameConflictWarning(
  file: string,
  projectRoot: string,
  conflict: RenameConflict,
  databases: DatabaseInfo[],
  tag: string
): string {
  const db = databases.find((d) => d.className === conflict.to);
  const newDir = db?.migrationsDir ? relativeDir(projectRoot, db.migrationsDir) : null;
  const oldDirs = db ? migrationsDirsOfClass(db, conflict.from).map((dir) => relativeDir(projectRoot, dir)) : [];
  const reason = conflict.reason
    .split(projectRoot + path.sep)
    .join('');
  const keep =
    newDir && oldDirs.length === 1
      ? `rm -r ${shellWord(newDir)} && mv ${shellWord(oldDirs[0])} ${shellWord(newDir)}`
      : `keep exactly one migrations directory for ${conflict.from} and move it to ${newDir ?? 'the new database\'s'}`;
  return (
    `[durable-db] ${file}: ${conflict.to} looks like ${conflict.from} under a new mount, but its ` +
    `data cannot move with it: ${reason}. A renamed_classes migration hands the new class the ` +
    `old storage and its __migrations journal, which names the migrations of the old directory — ` +
    `deployed with other migrations it would fail. Neither a rename nor a new class is written ` +
    `until you choose:\n` +
    `- keep the data (when ${newDir ?? 'the new directory'} was never deployed): ${keep}, then restart;\n` +
    `- start empty and DELETE the old data: add ${JSON.stringify({ tag, deleted_classes: [conflict.from] })} ` +
    `to "migrations"${oldDirs.length > 0 ? ` and remove ${oldDirs.join(', ')}` : ''}.`
  );
}

/** The log line for a rename written, with its migrations move and what dev keeps. */
function renameLog(file: string, projectRoot: string, rename: ClassRename, move: MigrationsMove | undefined): string {
  return (
    `[durable-db] ${file}: renamed the Durable Object class ${rename.from} to ${rename.to} ` +
    `(a renamed_classes migration): on deploy, Cloudflare moves its deployed data to the new class` +
    (move
      ? `, and ${relativeDir(projectRoot, move.from)} moved to ${relativeDir(projectRoot, move.to)} so its ` +
        `migrations still match the journal that data carries.`
      : ` (it has no migrations directory, so there is no deployed data to carry).`) +
    ` Local dev storage is kept per class name: in dev the database starts empty.`
  );
}

// ---------------------------------------------------------------------------
// Comment- and format-preserving edits
//
// Only the inserted or removed entries change: every other byte of the file —
// comments, the user's layout, the trailing newline — stays as it was. (A
// formatting `modify()` from jsonc-parser would reformat each line an edit
// touches, the neighbouring entry included.)
// ---------------------------------------------------------------------------

/** The file's own indentation unit and line ending, for inserted JSON. */
interface Layout {
  unit: string;
  eol: string;
}

function layoutOf(content: string): Layout {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  // The first indented key or value (a comment's continuation lines don't count).
  const indent = /^([ \t]+)["{[]/m.exec(content)?.[1];
  if (indent?.startsWith('\t')) return { unit: '\t', eol };
  return { unit: indent ? ' '.repeat(Math.min(indent.length, 8)) : '  ', eol };
}

/** Leading whitespace of the line holding `offset`. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** Whether only whitespace precedes `offset` on its line. */
function startsLine(text: string, offset: number): boolean {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(start, offset));
}

/** The offset of the line break ending the line holding `offset` (or the end of the text). */
function lineEnd(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  const end = newline === -1 ? text.length : newline;
  return end > offset && text[end - 1] === '\r' ? end - 1 : end;
}

/** Whether the rest of the line from `offset` is whitespace or a line comment. */
function restOfLineIsTrivia(text: string, offset: number): boolean {
  let i = offset;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i++;
  return i >= text.length || text[i] === '\n' || (text[i] === '/' && text[i + 1] === '/');
}

/** The offset of the next character that is not whitespace or a comment. */
function nextSignificant(text: string, offset: number): number {
  let i = offset;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      break;
    }
  }
  return i;
}

/** `value` as one line of JSON in hand-written style: `{ "name": "X", "class_name": "Y" }`. */
function inlineJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** `value` as pretty JSON whose continuation lines start at `indent`. */
function prettyJson(value: unknown, indent: string, layout: Layout): string {
  return JSON.stringify(value, null, layout.unit).split('\n').join(layout.eol + indent);
}

function treeOf(text: string): JsonNode {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!root) throw new SyntaxError('Invalid wrangler config');
  return root;
}

/**
 * Append an entry to the array or object at `containerPath`: on its own line
 * in the file's indentation when the container spans lines, inline when it
 * is written on one line. An entry with a `key` is a property of an object.
 */
function appendEntry(
  text: string,
  containerPath: JSONPath,
  entry: { value: unknown; key?: string },
  layout: Layout
): string {
  const container = findNodeAtLocation(treeOf(text), containerPath);
  if (!container || (container.type !== 'array' && container.type !== 'object')) {
    throw new Error(`Cannot append to ${containerPath.join('.')}: not an array or object`);
  }
  const keyPrefix = entry.key !== undefined ? `${JSON.stringify(entry.key)}: ` : '';
  const children = container.children ?? [];
  const containerEnd = container.offset + container.length; // just past the closing bracket
  const closing = containerEnd - 1;
  const containerIndent = lineIndent(text, container.offset);

  if (children.length === 0) {
    const open = text[container.offset];
    // Empty and sharing its line with more than a comma or comment
    // (`{ "bindings": [] }`): fill it in on that line.
    let afterContainer = containerEnd;
    while (text[afterContainer] === ' ' || text[afterContainer] === '\t') afterContainer++;
    if (text[afterContainer] === ',') afterContainer++;
    const sharesLine = !restOfLineIsTrivia(text, afterContainer);
    if (sharesLine) {
      const inner = open === '[' ? keyPrefix + inlineJson(entry.value) : ` ${keyPrefix}${inlineJson(entry.value)} `;
      return text.slice(0, container.offset) + open + inner + text.slice(closing);
    }
    const childIndent = containerIndent + layout.unit;
    const inner =
      layout.eol + childIndent + keyPrefix + prettyJson(entry.value, childIndent, layout) +
      layout.eol + containerIndent;
    return text.slice(0, container.offset) + open + inner + text.slice(closing);
  }

  const last = children[children.length - 1];
  const lastEnd = last.offset + last.length;
  const afterLast = nextSignificant(text, lastEnd);
  const trailingComma = text[afterLast] === ',';
  const separatorEnd = trailingComma ? afterLast + 1 : lastEnd;

  // Written on one line (`[{ … }]`): stay on it.
  if (!text.slice(container.offset, closing).includes('\n')) {
    const inserted = (trailingComma ? ' ' : ', ') + keyPrefix + inlineJson(entry.value);
    return text.slice(0, separatorEnd) + inserted + text.slice(separatorEnd);
  }

  const childIndent = startsLine(text, last.offset) ? lineIndent(text, last.offset) : containerIndent + layout.unit;
  const entryText = childIndent + keyPrefix + prettyJson(entry.value, childIndent, layout) + (trailingComma ? ',' : '');
  const comma = trailingComma ? '' : ',';

  // After the rest of the last entry's line (its comment stays with it), but
  // before the closing bracket when that shares the line.
  const end = lineEnd(text, separatorEnd);
  if (closing < end) {
    return (
      text.slice(0, lastEnd) + comma + text.slice(lastEnd, closing).replace(/[ \t]+$/, '') +
      layout.eol + entryText + layout.eol + containerIndent + text.slice(closing)
    );
  }
  return (
    text.slice(0, lastEnd) + comma + text.slice(lastEnd, end) +
    layout.eol + entryText + text.slice(end)
  );
}

/**
 * Remove the array element at `elementPath`, with its own lines (and a
 * comment on them) when it has lines of its own, and the comma it leaves.
 */
function removeElement(text: string, elementPath: JSONPath): string {
  const element = findNodeAtLocation(treeOf(text), elementPath);
  const array = element?.parent;
  if (!element || !array || array.type !== 'array') {
    throw new Error(`Cannot remove ${elementPath.join('.')}: not an array element`);
  }
  const siblings = array.children ?? [];
  const index = siblings.indexOf(element);
  const elementStart = element.offset;
  const elementEnd = element.offset + element.length;

  if (siblings.length === 1) {
    return text.slice(0, array.offset + 1) + text.slice(array.offset + array.length - 1);
  }

  const afterElement = nextSignificant(text, elementEnd);
  const ownComma = text[afterElement] === ',';
  const ownLines = startsLine(text, elementStart);

  let from = ownLines ? text.lastIndexOf('\n', elementStart - 1) + 1 : elementStart;
  let to = ownComma ? afterElement + 1 : elementEnd;
  if (ownLines && restOfLineIsTrivia(text, to)) {
    const newline = text.indexOf('\n', to);
    to = newline === -1 ? text.length : newline + 1;
  } else if (!ownLines) {
    while (to < text.length && (text[to] === ' ' || text[to] === '\t')) to++;
  }

  // The last element without a comma of its own: drop the comma before it.
  let commaBefore = -1;
  if (!ownComma && index > 0) {
    const previous = siblings[index - 1];
    const candidate = nextSignificant(text, previous.offset + previous.length);
    if (text[candidate] === ',') commaBefore = candidate;
    if (!ownLines) from = commaBefore !== -1 ? commaBefore : from;
  }

  let result = text.slice(0, from) + text.slice(to);
  if (commaBefore !== -1 && commaBefore < from) {
    result = result.slice(0, commaBefore) + result.slice(commaBefore + 1);
  }
  return result;
}

/**
 * The note for classes whose `deleted_classes` migration only the user may
 * write: the worker exports them as tombstones meanwhile, so nothing fails.
 */
function deletedClassesNote(file: string, classes: string[], tag: string): string {
  const entry = JSON.stringify({ tag, deleted_classes: classes });
  const list = classes.join(', ');
  const one = classes.length === 1;
  return (
    `[durable-db] note: ${file}: ${list} ${one ? 'is' : 'are'} no longer a discovered database, but ` +
    `the migrations still declare ${one ? 'it' : 'them'}. The worker exports ${one ? 'it' : 'them'} as ` +
    `${one ? 'a tombstone' : 'tombstones'} that keep${one ? 's' : ''} ${one ? 'its' : 'their'} data untouched ` +
    `and refuse${one ? 's' : ''} every call (410 Gone), so dev starts and deploys pass; restoring the ` +
    `database brings the data back. To delete ${one ? 'it' : 'them'} — and ALL ${one ? 'its' : 'their'} ` +
    `data — add this migration to "migrations" yourself:\n` +
    `  ${entry}\n` +
    `If ${one ? 'it was' : 'they were'} never deployed, remove ${list} from ` +
    `${one ? 'its' : 'their'} new_sqlite_classes entry instead.`
  );
}

/**
 * Patch wrangler config with Durable Object bindings
 *
 * Reconciles the config with the discovered databases, editing the file in
 * place so its comments, formatting and trailing newline survive:
 * - adds a binding and a `new_sqlite_classes` migration for each new database;
 * - removes durable-db's own bindings (`<X>_DATABASE_DO` → `<X>DatabaseDO`)
 *   whose class is no longer discovered (the worker exports it only as a
 *   tombstone);
 * - writes a `renamed_classes` migration when a database of a mounted source
 *   changed its class name unambiguously (a mount change), so its deployed
 *   data moves with it — and moves the old database's migrations directory
 *   to the new name, since that data carries the old migrations' journal;
 * - refuses such a rename when the migrations cannot follow (both
 *   directories exist, or several old ones): neither a rename nor a new class
 *   is written, `conflicts` lists it and a warning gives both ways out;
 * - never deletes a class (that deletes its data): a removed database's class
 *   stays, exported as a tombstone ({@link tombstoneClasses}), and a note
 *   gives the exact `deleted_classes` migration to add by hand.
 * Bindings of other names, and bindings to other workers' classes
 * (`script_name`), are never touched.
 */
export function patchWranglerConfig(
  projectRoot: string,
  databases: DatabaseInfo[]
): PatchResult {
  const configPath = findWranglerConfig(projectRoot);

  if (!configPath) {
    console.warn('[db] wrangler.jsonc/json not found');
    logRequiredConfig(databases);
    return unchangedPatch(null);
  }

  const file = path.basename(configPath);
  const movedMigrations: MigrationsMove[] = [];

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = parseWranglerConfig(content);
    const plan = reconcile(config, databases);
    const layout = layoutOf(content);
    let text = content;

    // Migrations directories move first: a rename whose directory cannot move
    // is refused, not written.
    for (const rename of [...plan.renamedClasses]) {
      const move = plan.migrationsMoves.get(rename.to);
      if (!move) continue;
      try {
        // An empty directory (a `db` command may create one) gives way.
        if (fs.existsSync(move.to)) fs.rmdirSync(move.to);
        fs.renameSync(move.from, move.to);
        movedMigrations.push(move);
      } catch (error) {
        plan.renamedClasses.splice(plan.renamedClasses.indexOf(rename), 1);
        plan.conflicts.push({
          ...rename,
          reason: `${move.from} could not be moved to ${move.to} (${(error as Error).message})`,
        });
      }
    }

    // Bindings: remove from the end so earlier indexes stay valid.
    for (const index of [...plan.removeBindingIndexes].sort((a, b) => b - a)) {
      text = removeElement(text, ['durable_objects', 'bindings', index]);
    }
    if (plan.addBindings.length > 0) {
      const durableObjects = config.durable_objects;
      if (durableObjects === undefined) {
        text = appendEntry(text, [], { key: 'durable_objects', value: { bindings: plan.addBindings } }, layout);
      } else if (durableObjects.bindings === undefined) {
        text = appendEntry(text, ['durable_objects'], { key: 'bindings', value: plan.addBindings }, layout);
      } else {
        for (const binding of plan.addBindings) {
          text = appendEntry(text, ['durable_objects', 'bindings'], { value: binding }, layout);
        }
      }
    }

    // Migrations: one new tag for the classes created and renamed.
    const migrations = Array.isArray(config.migrations) ? config.migrations : [];
    const migrationTag = plan.newClasses.length > 0 || plan.renamedClasses.length > 0 ? nextTag(migrations) : null;
    if (migrationTag) {
      const migration: WranglerMigration = {
        tag: migrationTag,
        ...(plan.newClasses.length > 0 && { new_sqlite_classes: plan.newClasses }),
        ...(plan.renamedClasses.length > 0 && { renamed_classes: plan.renamedClasses }),
      };
      text = config.migrations === undefined
        ? appendEntry(text, [], { key: 'migrations', value: [migration] }, layout)
        : appendEntry(text, ['migrations'], { value: migration }, layout);
    }

    const modified = text !== content;
    if (modified) {
      fs.writeFileSync(configPath, text, 'utf-8');
      debugVite('Updated %s with DO bindings', file);
    }

    // What changed is summed up by the caller (`reconcileWranglerConfig`);
    // a rename also gets the line that says what happens to its data.
    for (const rename of plan.renamedClasses) {
      console.log(renameLog(file, projectRoot, rename, plan.migrationsMoves.get(rename.to)));
    }
    // Suggested migrations get tags after the one just written, one each.
    const written = migrationTag ? [{ tag: migrationTag }] : [];
    const suggested: Array<{ tag: string }> = [...migrations, ...written];
    const suggestTag = () => {
      const tag = nextTag(suggested);
      suggested.push({ tag });
      return tag;
    };
    if (plan.deletedClasses.length > 0) {
      console.warn(deletedClassesNote(file, plan.deletedClasses, suggestTag()));
    }
    for (const conflict of plan.conflicts) {
      console.warn(renameConflictWarning(file, projectRoot, conflict, databases, suggestTag()));
    }

    return {
      modified,
      configPath,
      error: null,
      addedBindings: plan.addBindings,
      removedBindings: plan.removedBindings,
      newClasses: plan.newClasses,
      migrationTag,
      renamedClasses: plan.renamedClasses,
      movedMigrations,
      conflicts: plan.conflicts,
      deletedClasses: plan.deletedClasses,
    };
  } catch (error) {
    debugVite('Failed to patch wrangler config: %O', error);
    logRequiredConfig(databases);
    return { ...unchangedPatch(configPath, error as Error), movedMigrations };
  }
}

/** A {@link PatchResult} that changed nothing. */
export function unchangedPatch(configPath: string | null, error: Error | null = null): PatchResult {
  return {
    modified: false,
    configPath,
    error,
    addedBindings: [],
    removedBindings: [],
    newClasses: [],
    migrationTag: null,
    renamedClasses: [],
    movedMigrations: [],
    conflicts: [],
    deletedClasses: [],
  };
}

/**
 * Whether the config at `configPath` binds any of durable-db's own classes
 * (the bindings {@link patchWranglerConfig} reconciles). An unreadable config
 * binds none.
 */
export function bindsDurableDbClasses(configPath: string | null): boolean {
  if (!configPath) return false;
  try {
    const config = parseWranglerConfig(fs.readFileSync(configPath, 'utf-8'));
    return (config.durable_objects?.bindings ?? []).some(isDurableDbBinding);
  } catch {
    return false;
  }
}

/**
 * Check whether a JSONC string contains comments (outside of string literals).
 */
export function contentHasComments(content: string): boolean {
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    if (ch === '"') {
      i++;
      while (i < len) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '/' && i + 1 < len && (content[i + 1] === '/' || content[i + 1] === '*')) {
      return true;
    }

    i++;
  }

  return false;
}

/**
 * Log the required wrangler config for manual setup
 */
function logRequiredConfig(databases: DatabaseInfo[]): void {
  const bindings = databases.map(db => ({
    name: db.bindingName,
    class_name: db.className,
  }));

  const migrations = [{
    tag: 'v1',
    new_sqlite_classes: databases.map(db => db.className),
  }];

  debugVite('Required Durable Object config:\n%O', { durable_objects: { bindings }, migrations });
}

/**
 * Result of a read-only wrangler config check.
 */
export interface WranglerCheckResult {
  configPath: string | null;
  /** Bindings declared by databases but absent from the config */
  missingBindings: Array<{ name: string; class_name: string }>;
  /**
   * DO classes no migration declares — a rename target is not missing: its
   * `renamed_classes` entry is in {@link renamedClasses}.
   */
  missingSqliteClasses: string[];
  /**
   * durable-db's own bindings to a class that is no longer a discovered
   * database (exported only as a tombstone): a production build fails on them.
   */
  staleBindings: DurableObjectBinding[];
  /**
   * Classes of durable-db's naming the migrations still declare but no
   * discovered database has: a rename needs a `renamed_classes` migration; a
   * removed database's class is no failure — the worker exports a tombstone
   * of it until the user adds the `deleted_classes` migration (a note says how).
   */
  staleClasses: string[];
  /** The `renamed_classes` entries the config lacks (a mount change). */
  renamedClasses: ClassRename[];
  /** The migrations directories those renames need moved. */
  migrationsMoves: MigrationsMove[];
  /** Renames that cannot be written as they stand (see {@link RenameConflict}). */
  conflicts: RenameConflict[];
  ok: boolean;
  /**
   * True when the project only has a wrangler.toml — the check can't parse
   * it, so `ok: false` may be a false negative and callers shouldn't treat
   * it as fatal.
   */
  tomlOnly: boolean;
}

/**
 * What a failed {@link checkWranglerConfig} found, in one sentence: what is
 * missing and what is stale.
 */
export function describeWranglerCheck(check: WranglerCheckResult): string {
  const parts: string[] = [];
  if (check.missingBindings.length > 0) {
    parts.push(`missing the binding(s) ${check.missingBindings.map((b) => b.name).join(', ')}`);
  }
  if (check.missingSqliteClasses.length > 0) {
    parts.push(`missing a migration declaring ${check.missingSqliteClasses.join(', ')}`);
  }
  if (check.renamedClasses.length > 0) {
    parts.push(
      `missing the renamed_classes migration for ${check.renamedClasses.map((r) => `${r.from} → ${r.to}`).join(', ')}`
    );
  }
  if (check.staleBindings.length > 0) {
    parts.push(
      `binding class(es) of database(s) that no longer exist (${check.staleBindings.map((b) => b.class_name).join(', ')})`
    );
  }
  if (check.conflicts.length > 0) {
    parts.push(
      `holding renamed database(s) whose migrations cannot follow (${check.conflicts.map((c) => `${c.from} → ${c.to}`).join(', ')})`
    );
  }
  return parts.join('; ');
}

/**
 * Verify (without writing) that the wrangler config contains the Durable
 * Object bindings and sqlite migration entries the discovered databases
 * need, and no binding or class of a database that is gone. Logs an
 * actionable warning with the exact JSON to add (or remove) when something
 * is off — and, for a rename, the `mv` that moves its migrations with it.
 *
 * This is the default behavior of the Vite plugin — automatic patching
 * is opt-in via the `patchWranglerConfig` plugin option.
 */
export function checkWranglerConfig(
  projectRoot: string,
  databases: DatabaseInfo[]
): WranglerCheckResult {
  const configPath = findWranglerConfig(projectRoot);

  const result: WranglerCheckResult = {
    configPath,
    missingBindings: [],
    missingSqliteClasses: [],
    staleBindings: [],
    staleClasses: [],
    renamedClasses: [],
    migrationsMoves: [],
    conflicts: [],
    ok: true,
    tomlOnly: !configPath && fs.existsSync(path.join(projectRoot, 'wrangler.toml')),
  };

  let config: WranglerConfig = {};
  if (configPath) {
    try {
      config = parseWranglerConfig(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      debugVite('Failed to parse wrangler config for check: %O', error);
    }
  }

  const plan = reconcile(config, databases);
  result.missingBindings = plan.addBindings;
  result.missingSqliteClasses = plan.newClasses;
  result.staleBindings = plan.removedBindings;
  result.renamedClasses = plan.renamedClasses;
  result.migrationsMoves = plan.renamedClasses.flatMap((r) => plan.migrationsMoves.get(r.to) ?? []);
  result.conflicts = plan.conflicts;
  result.staleClasses = [
    ...plan.renamedClasses.map((r) => r.from),
    ...plan.conflicts.map((c) => c.from),
    ...plan.deletedClasses,
  ];
  // A removed database's class is no failure: the worker exports its tombstone.
  result.ok =
    result.missingBindings.length === 0 &&
    result.missingSqliteClasses.length === 0 &&
    result.staleBindings.length === 0 &&
    plan.renamedClasses.length === 0 &&
    plan.conflicts.length === 0;

  const existingMigrations = Array.isArray(config.migrations) ? config.migrations : [];
  const migration =
    plan.newClasses.length > 0 || plan.renamedClasses.length > 0
      ? {
          tag: nextTag(existingMigrations),
          ...(plan.newClasses.length > 0 && { new_sqlite_classes: plan.newClasses }),
          ...(plan.renamedClasses.length > 0 && { renamed_classes: plan.renamedClasses }),
        }
      : null;
  const suggested: Array<{ tag: string }> = [...existingMigrations, ...(migration ? [migration] : [])];
  const suggestTag = () => {
    const tag = nextTag(suggested);
    suggested.push({ tag });
    return tag;
  };

  const file = configPath ? path.basename(configPath) : 'wrangler.jsonc';
  if (result.missingBindings.length > 0 || migration) {
    const snippet = JSON.stringify(
      {
        ...(result.missingBindings.length > 0 && {
          durable_objects: { bindings: result.missingBindings },
        }),
        ...(migration && { migrations: [migration] }),
      },
      null,
      2
    );

    // Verification and patching only understand wrangler.jsonc/json. If the
    // project uses wrangler.toml, say so explicitly instead of suggesting a
    // second config file.
    const hasToml = result.tomlOnly;
    const where = configPath
      ? path.basename(configPath)
      : hasToml
        ? 'wrangler.toml (not supported — only wrangler.jsonc/json can be verified or patched)'
        : 'wrangler.jsonc';

    const moves = result.migrationsMoves.map(
      (move) =>
        `mv ${shellWord(relativeDir(projectRoot, move.from))} ${shellWord(relativeDir(projectRoot, move.to))}`
    );
    console.warn(
      `[durable-db] ${where} is missing ` +
      `Durable Object config for your database(s). Add ${hasToml ? 'the equivalent of ' : ''}this` +
      `${configPath || hasToml ? '' : ' to a new wrangler.jsonc'}:\n` +
      `${snippet}\n` +
      (plan.renamedClasses.length > 0
        ? `renamed_classes hands each new class the old one's deployed data (the same database under a ` +
          `new mount)` +
          (moves.length > 0
            ? `, and that data's __migrations journal names the old migrations — move them with it:\n` +
              moves.map((move) => `  ${move}`).join('\n') + '\n'
            : '.\n')
        : '') +
      (hasToml
        ? ''
        : `Or let the plugin write it for you: durableDb({ patchWranglerConfig: true })`)
    );
  }

  if (result.staleBindings.length > 0 || plan.conflicts.length > 0) {
    const lines: string[] = [];
    if (result.staleBindings.length > 0) {
      lines.push(
        `remove the Durable Object binding(s) ${result.staleBindings.map((b) => `${b.name} (${b.class_name})`).join(', ')}: ` +
        `no database defines ${result.staleBindings.length === 1 ? 'that class' : 'those classes'} any more ` +
        `(the worker exports ${result.staleBindings.length === 1 ? 'it' : 'them'} only as a tombstone)`
      );
    }
    // The standalone warnings, as items of this one's list.
    const item = (warning: string) => warning.replace(`[durable-db] ${file}: `, '');
    for (const conflict of plan.conflicts) {
      lines.push(item(renameConflictWarning(file, projectRoot, conflict, databases, suggestTag())));
    }
    console.warn(
      `[durable-db] ${file} declares Durable Objects of database(s) that no longer exist:\n` +
      lines.map((line) => `- ${line}`).join('\n') +
      (plan.conflicts.length > 0
        ? ''
        : `\nOr let the plugin reconcile the bindings for you: durableDb({ patchWranglerConfig: true })`)
    );
  }
  if (plan.deletedClasses.length > 0) {
    console.warn(deletedClassesNote(file, plan.deletedClasses, suggestTag()));
  }

  return result;
}

/**
 * Generate the required wrangler config as a string
 * Useful for displaying to users or tests
 */
export function generateRequiredConfig(databases: DatabaseInfo[]): WranglerConfig {
  return {
    durable_objects: {
      bindings: databases.map(db => ({
        name: db.bindingName,
        class_name: db.className,
      })),
    },
    migrations: [{
      tag: 'v1',
      new_sqlite_classes: databases.map(db => db.className),
    }],
  };
}
