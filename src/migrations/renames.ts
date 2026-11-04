import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';

type Snapshot = DrizzleSQLiteSnapshotJSON;

// The parts of drizzle-kit's SQLite snapshot (version 6) read here, typed
// structurally: its own type is inferred from zod schemas and does not
// survive into every consumer's type-check.
export interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  autoincrement?: boolean;
  default?: unknown;
  generated?: unknown;
}

export interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, { name: string; columns: string[] }>;
  foreignKeys: Record<string, {
    tableFrom: string;
    tableTo: string;
    columnsFrom: string[];
    columnsTo: string[];
  }>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { columns: string[] }>;
}

export interface SnapshotShape {
  tables: Record<string, SnapshotTable>;
  views: Record<string, unknown>;
}

/** A snapshot, read through {@link SnapshotShape}. */
export function shape(snapshot: Snapshot): SnapshotShape {
  const s = snapshot as unknown as Partial<SnapshotShape>;
  return { tables: s.tables ?? {}, views: s.views ?? {} };
}

// ============================================================================
// Rename answers
// ============================================================================
//
// drizzle-kit cannot tell a renamed column (or table) from a dropped one plus
// a new one, so its diff asks — interactively, through prompts that need a
// TTY. Its API takes no answers (the resolvers are internal), so durable-db
// resolves the ambiguity itself BEFORE handing the snapshots over:
//
// - a rename answer is applied to the previous snapshot (the column/table is
//   renamed there, references included) and its `ALTER TABLE … RENAME`
//   statement is emitted by durable-db, so drizzle-kit only sees what is left;
// - "create + drop" for the rest splits the diff in two — the drops (prev →
//   prev minus everything that disappears) and the additions (that → current)
//   — neither of which has both an added and a removed name, so drizzle-kit
//   never asks.

/** One answer to drizzle-kit's "created or renamed?" question. */
export type RenameAnswer =
  | { kind: 'table'; from: string; to: string }
  | { kind: 'column'; table: string; from: string; to: string };

/**
 * Parse a rename answer as typed on the command line:
 * `<table>.<old>=<new>` renames a column, `<old>=<new>` a table. Names are the
 * SQL names (snake_case, as in the migration files); a camelCase property name
 * is accepted too and converted the way durable-db's schema does.
 */
export function parseRenameSpec(spec: string): RenameAnswer {
  const match = /^\s*([^=\s]+)\s*=\s*([^=\s]+)\s*$/.exec(spec);
  if (!match) {
    throw new Error(
      `Invalid rename '${spec}': expected <table>.<old>=<new> for a column or <old>=<new> for a table ` +
      `(e.g. products.description=summary).`
    );
  }
  const [, left, right] = match;
  const leftParts = left.split('.');
  if (leftParts.length === 2 && leftParts[0] && leftParts[1]) {
    const to = right.includes('.') ? right.split('.').pop()! : right;
    return { kind: 'column', table: leftParts[0], from: leftParts[1], to };
  }
  if (leftParts.length === 1 && !right.includes('.')) {
    return { kind: 'table', from: left, to: right };
  }
  throw new Error(
    `Invalid rename '${spec}': expected <table>.<old>=<new> for a column or <old>=<new> for a table.`
  );
}

export function formatRename(answer: RenameAnswer): string {
  return answer.kind === 'column'
    ? `${answer.table}.${answer.from}=${answer.to}`
    : `${answer.from}=${answer.to}`;
}

/** drizzle's snake_case conversion (`casing: 'snake_case'`), for camelCase input. */
export function toSnakeCase(input: string): string {
  const words = input.replace(/['’]/g, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/g) ?? [];
  return words.map((word) => word.toLowerCase()).join('_');
}

/** The name as it appears in `names`: verbatim, else its snake_case form. */
function matchName(name: string, names: Iterable<string>): string | null {
  const set = new Set(names);
  if (set.has(name)) return name;
  const snake = toSnakeCase(name);
  return set.has(snake) ? snake : null;
}

// ============================================================================
// Ambiguities
// ============================================================================

/**
 * A place where drizzle-kit would ask "created or renamed?": a table (or
 * view) set, or one table's columns, with both new and vanished names.
 */
export interface SchemaAmbiguity {
  kind: 'table' | 'column' | 'view';
  /** The table, for a column ambiguity. */
  table?: string;
  /** Names only in the new schema. */
  created: string[];
  /** Names only in the old schema. */
  deleted: string[];
}

function keysOnlyIn(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): string[] {
  return Object.keys(a ?? {}).filter((key) => !(key in (b ?? {})));
}

/** Every question drizzle-kit would ask to diff `prev` → `cur`. */
export function findAmbiguities(prevSnapshot: Snapshot, curSnapshot: Snapshot): SchemaAmbiguity[] {
  const prev = shape(prevSnapshot);
  const cur = shape(curSnapshot);
  const ambiguities: SchemaAmbiguity[] = [];

  const createdTables = keysOnlyIn(cur.tables, prev.tables);
  const deletedTables = keysOnlyIn(prev.tables, cur.tables);
  if (createdTables.length > 0 && deletedTables.length > 0) {
    ambiguities.push({ kind: 'table', created: createdTables, deleted: deletedTables });
  }

  for (const [name, table] of Object.entries(cur.tables ?? {})) {
    const before = prev.tables?.[name];
    if (!before) continue;
    const created = keysOnlyIn(table.columns, before.columns);
    const deleted = keysOnlyIn(before.columns, table.columns);
    if (created.length > 0 && deleted.length > 0) {
      ambiguities.push({ kind: 'column', table: name, created, deleted });
    }
  }

  const createdViews = keysOnlyIn(cur.views, prev.views);
  const deletedViews = keysOnlyIn(prev.views, cur.views);
  if (createdViews.length > 0 && deletedViews.length > 0) {
    ambiguities.push({ kind: 'view', created: createdViews, deleted: deletedViews });
  }

  return ambiguities;
}

/** One line per ambiguity: `products: summary added, description removed`. */
export function describeAmbiguity(ambiguity: SchemaAmbiguity): string {
  const where = ambiguity.kind === 'column' ? `${ambiguity.table}: ` : `${ambiguity.kind}s: `;
  return `${where}${ambiguity.created.join(', ')} added, ${ambiguity.deleted.join(', ')} removed`;
}

/** Example `--rename` answers for an ambiguity (each new name from the first vanished one). */
export function exampleRenames(ambiguity: SchemaAmbiguity): string[] {
  if (ambiguity.kind === 'view') return [];
  const from = ambiguity.deleted[0];
  return ambiguity.created.slice(0, 1).map((to) =>
    ambiguity.kind === 'column' ? `${ambiguity.table}.${from}=${to}` : `${from}=${to}`
  );
}

/**
 * The diff needs answers drizzle-kit can only ask for in a terminal: no TTY,
 * or a caller that asked for no prompts, and no `--rename` / `--no-renames`
 * answer for these.
 */
export class SchemaRenameRequiredError extends Error {
  /** Set by the CLI to the database the diff belongs to. */
  database?: string;

  constructor(readonly ambiguities: SchemaAmbiguity[]) {
    super('');
    this.name = 'SchemaRenameRequiredError';
    this.message = this.describe();
  }

  /** Name the database the diff belongs to (in the message too). */
  forDatabase(database: string): this {
    this.database = database;
    this.message = this.describe();
    return this;
  }

  /**
   * The message, naming the command to re-run (`lagerverk db generate`, `db push`…).
   */
  describe(command = 'db push / db generate'): string {
    const examples = this.ambiguities.flatMap(exampleRenames);
    const lines = [
      `${this.database ? `${this.database}: ` : ''}the schema change needs rename resolution — ` +
        `drizzle-kit asks whether these are renames, and its prompts need an interactive terminal (TTY):`,
      ...this.ambiguities.map((a) => `  ${describeAmbiguity(a)}`),
      `Answer in a terminal by running \`${command}\` there, or on the command line:`,
      ...(examples.length > 0
        ? [`  ${command} --rename ${examples[0]}   (a rename: the data is kept; repeat --rename for each)`]
        : []),
      `  ${command} --no-renames   (create + drop: the removed ones' data is lost)`,
    ];
    return lines.join('\n');
  }
}

// ============================================================================
// Applying answers
// ============================================================================

export interface AppliedRenames {
  /** `prev` with the renames applied (a copy). */
  snapshot: Snapshot;
  /** The `ALTER TABLE … RENAME` statements, in drizzle-kit's own format. */
  statements: string[];
  /** The answers that applied here, normalized to the snapshot's names. */
  applied: RenameAnswer[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renameTableRefs(snapshot: SnapshotShape, from: string, to: string): void {
  for (const table of Object.values(snapshot.tables ?? {})) {
    for (const fk of Object.values(table.foreignKeys ?? {})) {
      if (fk.tableFrom === from) fk.tableFrom = to;
      if (fk.tableTo === from) fk.tableTo = to;
    }
  }
}

function renameColumnRefs(snapshot: SnapshotShape, tableName: string, from: string, to: string): void {
  const swap = (columns: string[]) => columns.map((c) => (c === from ? to : c));
  const table = snapshot.tables[tableName];
  for (const index of Object.values(table.indexes ?? {})) index.columns = swap(index.columns);
  for (const pk of Object.values(table.compositePrimaryKeys ?? {})) pk.columns = swap(pk.columns);
  for (const unique of Object.values(table.uniqueConstraints ?? {})) unique.columns = swap(unique.columns);
  for (const other of Object.values(snapshot.tables ?? {})) {
    for (const fk of Object.values(other.foreignKeys ?? {})) {
      if (fk.tableFrom === tableName) fk.columnsFrom = swap(fk.columnsFrom);
      if (fk.tableTo === tableName) fk.columnsTo = swap(fk.columnsTo);
    }
  }
}

/**
 * Apply rename answers to `prev`, as SQLite's `ALTER TABLE … RENAME` does
 * (references in indexes, keys and foreign keys follow the new name). An
 * answer applies when its old name exists only in `prev` and its new name
 * only in `cur`; answers that match nothing here are left out of `applied`
 * (the caller decides whether an unused answer is an error — with several
 * databases, an answer usually belongs to one of them).
 */
export function applyRenames(prevSnapshot: Snapshot, curSnapshot: Snapshot, answers: RenameAnswer[]): AppliedRenames {
  const copy = clone(prevSnapshot);
  const snapshot = shape(copy);
  const cur = shape(curSnapshot);
  const statements: string[] = [];
  const applied: RenameAnswer[] = [];

  // Tables first: a column answer names the table by its new name or its old.
  for (const answer of answers) {
    if (answer.kind !== 'table') continue;
    const from = matchName(answer.from, keysOnlyIn(snapshot.tables, cur.tables));
    const to = matchName(answer.to, keysOnlyIn(cur.tables, snapshot.tables));
    if (!from || !to) continue;
    const table = snapshot.tables[from];
    delete snapshot.tables[from];
    table.name = to;
    snapshot.tables[to] = table;
    renameTableRefs(snapshot, from, to);
    statements.push(`ALTER TABLE \`${from}\` RENAME TO \`${to}\`;`);
    applied.push({ kind: 'table', from, to });
  }

  const renamedTo = new Map(
    applied.flatMap((a) => (a.kind === 'table' ? [[a.from, a.to] as const] : []))
  );
  const resolveTable = (name: string): string | null => {
    const current = matchName(name, Object.keys(snapshot.tables ?? {}));
    if (current) return current;
    const old = matchName(name, renamedTo.keys());
    return old ? renamedTo.get(old)! : null;
  };

  for (const answer of answers) {
    if (answer.kind !== 'column') continue;
    const tableName = resolveTable(answer.table);
    if (!tableName || !cur.tables?.[tableName]) continue;
    const table: SnapshotTable = snapshot.tables[tableName];
    const from = matchName(answer.from, keysOnlyIn(table.columns, cur.tables[tableName].columns));
    const to = matchName(answer.to, keysOnlyIn(cur.tables[tableName].columns, table.columns));
    if (!from || !to) continue;
    const columns: SnapshotTable['columns'] = {};
    for (const [key, column] of Object.entries(table.columns)) {
      if (key === from) {
        columns[to] = { ...column, name: to };
      } else {
        columns[key] = column;
      }
    }
    table.columns = columns;
    renameColumnRefs(snapshot, tableName, from, to);
    statements.push(`ALTER TABLE \`${tableName}\` RENAME COLUMN "${from}" TO "${to}";`);
    applied.push({ kind: 'column', table: tableName, from, to });
  }

  return { snapshot: copy, statements, applied };
}

/**
 * `prev` minus every table, view and column that is not in `cur` — along with
 * the indexes, keys and foreign keys that name them. Diffing `prev` → this
 * yields only drops, and this → `cur` only additions: the "create + drop"
 * answer to every remaining rename question, without one.
 */
export function withoutRemoved(prevSnapshot: Snapshot, curSnapshot: Snapshot): Snapshot {
  const copy = clone(prevSnapshot);
  const snapshot = shape(copy);
  const cur = shape(curSnapshot);
  const removedTables = new Set(keysOnlyIn(snapshot.tables, cur.tables));
  const removedColumns = new Map<string, Set<string>>();

  for (const name of removedTables) delete snapshot.tables[name];
  for (const name of keysOnlyIn(snapshot.views, cur.views)) delete snapshot.views[name];

  for (const [name, table] of Object.entries(snapshot.tables)) {
    const gone = new Set(keysOnlyIn(table.columns, cur.tables[name]?.columns));
    if (gone.size === 0) continue;
    removedColumns.set(name, gone);
    for (const column of gone) delete table.columns[column];
  }

  const touches = (tableName: string, columns: string[]) =>
    columns.some((c) => removedColumns.get(tableName)?.has(c));

  for (const [name, table] of Object.entries(snapshot.tables)) {
    for (const [key, index] of Object.entries(table.indexes ?? {})) {
      if (touches(name, index.columns)) delete table.indexes[key];
    }
    for (const [key, pk] of Object.entries(table.compositePrimaryKeys ?? {})) {
      if (touches(name, pk.columns)) delete table.compositePrimaryKeys[key];
    }
    for (const [key, unique] of Object.entries(table.uniqueConstraints ?? {})) {
      if (touches(name, unique.columns)) delete table.uniqueConstraints[key];
    }
    for (const [key, fk] of Object.entries(table.foreignKeys ?? {})) {
      if (
        removedTables.has(fk.tableTo) ||
        touches(name, fk.columnsFrom) ||
        touches(fk.tableTo, fk.columnsTo)
      ) {
        delete table.foreignKeys[key];
      }
    }
  }

  return copy;
}

function sameName(a: string, b: string): boolean {
  return a === b || toSnakeCase(a) === b;
}

/**
 * The answers no diff used — an answer that matches no pending change is a
 * typo or a stale flag, worth an error rather than silence. `performed` are
 * the renames the generated statements carry ({@link renamesFromStatements}).
 */
export function unusedRenames(answers: RenameAnswer[], performed: RenameAnswer[]): RenameAnswer[] {
  const tableRenames = performed.filter((r) => r.kind === 'table');
  const tableAliases = (name: string) => [
    name,
    ...tableRenames.filter((r) => sameName(name, r.from)).map((r) => r.to),
  ];
  return answers.filter((answer) => !performed.some((rename) => {
    if (answer.kind !== rename.kind) return false;
    if (answer.kind === 'table') return sameName(answer.from, rename.from) && sameName(answer.to, rename.to);
    const r = rename as Extract<RenameAnswer, { kind: 'column' }>;
    return (
      tableAliases(answer.table).some((t) => sameName(t, r.table)) &&
      sameName(answer.from, r.from) &&
      sameName(answer.to, r.to)
    );
  }));
}

/**
 * The renames a statement list performs (drizzle-kit's own, after an
 * interactive answer, or durable-db's). drizzle-kit's table recreation
 * (`__new_<table>` renamed back) is not a rename.
 */
export function renamesFromStatements(statements: string[]): RenameAnswer[] {
  const renames: RenameAnswer[] = [];
  for (const statement of statements) {
    const column = /^\s*ALTER TABLE [`"]([^`"]+)[`"] RENAME COLUMN [`"]([^`"]+)[`"] TO [`"]([^`"]+)[`"]/i.exec(statement);
    if (column) {
      renames.push({ kind: 'column', table: column[1], from: column[2], to: column[3] });
      continue;
    }
    const table = /^\s*ALTER TABLE [`"]([^`"]+)[`"] RENAME TO [`"]([^`"]+)[`"]/i.exec(statement);
    if (table && !table[1].startsWith('__new_')) {
      renames.push({ kind: 'table', from: table[1], to: table[2] });
    }
  }
  return renames;
}
