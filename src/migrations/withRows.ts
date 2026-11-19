// Replays migrations on a database that has rows.
//
// A migration replayed on an empty database proves it is valid SQL. What goes
// wrong in production goes wrong on rows: a column made NOT NULL where a row
// holds NULL, a foreign key added where a row references nothing, a unique
// index over two rows that hold the same value, a rebuild that takes rows
// along. Per-tenant databases migrate lazily, each on its first request after
// a deploy, and nobody can look into every one of them first — so a migration
// has to pass on EVERY database the schema before it allows. This replays
// each migration on one such database, filled with rows that are valid for
// the schema as it is and as unkind as that schema lets them be: every
// nullable column NULL in a row, the same values in two rows wherever nothing
// says they are unique, and columns no constraint ties to another table
// holding values no row there has.
//
// It runs as a Durable Object runs a migration: foreign keys on and staying
// on (`PRAGMA foreign_keys=OFF` does nothing there), each chunk in a
// transaction, the rows that reference a rebuilt table kept through its DROP
// (referencingRows.ts). So what passes here passes there, and what a tenant's
// object would refuse is refused here first.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guardReferencingRows, type Sql } from '../db/referencingRows';
import { renamesFromStatements } from './renames';

/** The part of libsql's (better-sqlite3's) API the replay uses. */
export interface RowsDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  close(): void;
}

export type RowsDatabaseConstructor = new (filename: string) => RowsDatabase;

export type RowsFindingKind = 'fails' | 'loses-rows' | 'loses-values';

/** What a migration does to a database that has rows, and should not. */
export interface RowsFinding {
  migration: string;
  kind: RowsFindingKind;
  table?: string;
  column?: string;
  /** Of a failure: the chunk and the statement that failed, and what SQLite said. */
  chunk?: number;
  statement?: string;
  error?: string;
  message: string;
  /** Names the finding from one run to the next: what an acceptance is recorded by. */
  fingerprint: string;
}

export interface RowsReplay {
  findings: RowsFinding[];
  /** Tables no row could be made for (a CHECK the made-up values do not meet, say): not checked against rows. */
  unseeded: { table: string; reason: string }[];
  /** A migration that fails on an empty database too: the replay stopped there. */
  stopped?: { migration: string; error: string };
}

type Row = Record<string, unknown>;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** SQL through the database as a Durable Object's `sql.exec` runs it. */
function objectSql(db: RowsDatabase): Sql {
  return {
    exec(query, ...bindings) {
      // A Durable Object ignores it: foreign keys are enforced, and stay enforced.
      if (/^\s*PRAGMA\s+foreign_keys\s*=/i.test(query)) return { toArray: () => [] };
      const reads = /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(query) || /^\s*PRAGMA\b[^=]*$/i.test(query);
      if (reads) {
        const rows = db.prepare(query).all(...bindings) as Row[];
        return { toArray: () => rows };
      }
      if (bindings.length > 0) db.prepare(query).run(...bindings);
      else db.exec(query);
      return { toArray: () => [] };
    },
  };
}

const all = (db: RowsDatabase, query: string, ...params: unknown[]): Row[] => db.prepare(query).all(...params) as Row[];

/** The app's tables: not SQLite's own, not durable-db's journals, not a rebuild's leftovers. */
function userTables(db: RowsDatabase): string[] {
  return all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sqlite_') && !name.startsWith('__'));
}

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  /** Its place in the primary key, 0 for none. */
  pk: number;
}

interface Reference {
  parent: string;
  /** Column of this table → column of the parent (null: the parent's primary key). */
  columns: { from: string; to: string | null }[];
}

interface TableShape {
  name: string;
  columns: Column[];
  references: Reference[];
  /** The columns something says are unique: the primary key, a unique column, a unique index. */
  unique: Set<string>;
}

function shapeOf(db: RowsDatabase, table: string): TableShape {
  const columns = all(db, `PRAGMA table_xinfo(${quote(table)})`)
    // Generated columns are not written.
    .filter((row) => Number(row.hidden ?? 0) === 0)
    .map((row): Column => ({ name: String(row.name), type: String(row.type ?? '').toUpperCase(), notNull: Number(row.notnull) === 1, pk: Number(row.pk) }));
  const references = new Map<number, Reference>();
  for (const row of all(db, `PRAGMA foreign_key_list(${quote(table)})`)) {
    const id = Number(row.id);
    let reference = references.get(id);
    if (!reference) references.set(id, (reference = { parent: String(row.table), columns: [] }));
    reference.columns.push({ from: String(row.from), to: row.to === null || row.to === undefined ? null : String(row.to) });
  }
  const unique = new Set<string>(columns.filter((column) => column.pk > 0).map((column) => column.name));
  for (const index of all(db, `PRAGMA index_list(${quote(table)})`)) {
    if (Number(index.unique) !== 1) continue;
    for (const part of all(db, `PRAGMA index_info(${quote(String(index.name))})`)) if (part.name !== null && part.name !== undefined) unique.add(String(part.name));
  }
  return { name: table, columns, references: [...references.values()], unique };
}

/** The primary key of a table's parent row, as the foreign key names it or as the table declares it. */
function parentColumn(db: RowsDatabase, parent: string, to: string | null): string | null {
  if (to !== null) return to;
  const key = all(db, `PRAGMA table_xinfo(${quote(parent)})`).filter((row) => Number(row.pk) > 0);
  return key.length === 1 ? String(key[0]!.name) : null;
}

/** A made-up value of a column's declared type. `n` is unique to the value; `same` says two rows may share it. */
function made(column: Column, n: number, same: boolean): unknown {
  const type = column.type;
  if (type.includes('INT')) return same ? 1 : 1000 + n;
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return same ? 1.5 : n + 0.5;
  if (type.includes('BLOB')) return Buffer.from(same ? [0] : [n & 255, (n >> 8) & 255]);
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT') || type === '') return same ? column.name : `${column.name}-${n}`;
  // NUMERIC and whatever else a table was declared with.
  return same ? 1 : 1000 + n;
}

/**
 * Three rows for every table, on top of what it has: one with every column
 * filled, one with every nullable column NULL, one that repeats the first
 * wherever nothing says a value is unique. References point at rows that
 * exist — the schema demands it —; everything else is what the schema allows.
 */
function seed(db: RowsDatabase, state: { n: number }): { table: string; reason: string }[] {
  const unseeded = new Map<string, string>();
  const tables = userTables(db).map((table) => shapeOf(db, table));
  const done = new Set<string>();
  // Parents before the tables that reference them; a table that waits for one that never comes is tried last, as it is.
  for (let pass = 0; pass <= tables.length && done.size < tables.length; pass++) {
    for (const table of tables) {
      if (done.has(table.name)) continue;
      const waits = table.references.some((reference) => reference.parent !== table.name && !done.has(reference.parent) && tables.some((other) => other.name === reference.parent));
      if (waits && pass < tables.length) continue;
      done.add(table.name);
      let inserted = 0;
      let reason = '';
      for (const kind of [0, 1, 2] as const) {
        const values = new Map<string, unknown>();
        let possible = true;
        for (const reference of table.references) {
          // A reference that may be empty is empty in the sparse row.
          const optional = reference.columns.every(({ from }) => !table.columns.find((column) => column.name === from)?.notNull);
          if (kind === 1 && optional) {
            for (const { from } of reference.columns) values.set(from, null);
            continue;
          }
          const targets = reference.columns.map(({ to }) => parentColumn(db, reference.parent, to));
          const parents = targets.every((target) => target !== null) ? all(db, `SELECT ${targets.map((target) => quote(target!)).join(', ')} FROM ${quote(reference.parent)} LIMIT 3`) : [];
          const parent = parents[kind % Math.max(parents.length, 1)];
          if (!parent) {
            if (!optional) {
              possible = false;
              reason = `it references ${reference.parent}, which has no row to reference`;
            } else for (const { from } of reference.columns) values.set(from, null);
            continue;
          }
          reference.columns.forEach(({ from }, at) => values.set(from, parent[targets[at]!]));
        }
        if (!possible) continue;
        for (const column of table.columns) {
          if (values.has(column.name)) continue;
          // An INTEGER PRIMARY KEY is the rowid: SQLite gives it.
          if (column.pk > 0 && column.type.includes('INT') && table.columns.filter((other) => other.pk > 0).length === 1) continue;
          const n = ++state.n;
          if (kind === 1 && !column.notNull && column.pk === 0) values.set(column.name, null);
          else values.set(column.name, made(column, n, !table.unique.has(column.name) && kind !== 1));
        }
        const names = [...values.keys()];
        try {
          const sql = names.length > 0 ? `INSERT INTO ${quote(table.name)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})` : `INSERT INTO ${quote(table.name)} DEFAULT VALUES`;
          db.prepare(sql).run(...names.map((name) => values.get(name)));
          inserted++;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      if (inserted === 0) unseeded.set(table.name, reason || 'no row could be made');
    }
  }
  return [...unseeded].map(([table, reason]) => ({ table, reason }));
}

interface TableRows {
  columns: string[];
  /** The primary key's columns; empty where the table has none to tell its rows apart by. */
  key: string[];
  rows: Map<string, Row>;
  count: number;
}

const keyOf = (row: Row, key: string[]): string => JSON.stringify(key.map((column) => (Buffer.isBuffer(row[column]) ? (row[column] as Buffer).toString('hex') : row[column])));

function snapshot(db: RowsDatabase): Map<string, TableRows> {
  const tables = new Map<string, TableRows>();
  for (const table of userTables(db)) {
    const shape = shapeOf(db, table);
    const key = shape.columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const rows = all(db, `SELECT * FROM ${quote(table)}`);
    tables.set(table, { columns: shape.columns.map((column) => column.name), key, rows: new Map(key.length > 0 ? rows.map((row) => [keyOf(row, key), row]) : []), count: rows.length });
  }
  return tables;
}

const lower = (name: string): string => name.toLowerCase();

/** Whether the migration itself writes to a table's rows: then what happens to them is what its author wrote. */
function writes(statements: string[], verb: 'DELETE FROM' | 'UPDATE', table: string): boolean {
  const pattern = new RegExp(`^\\s*${verb}\\s+[\`"\\[]?${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\`"\\]]?(\\s|$)`, 'i');
  return statements.some((statement) => pattern.test(statement));
}

/** What the rows that were there before a migration have lost by it. */
function compare(migration: string, statements: string[], before: Map<string, TableRows>, after: Map<string, TableRows>): RowsFinding[] {
  const findings: RowsFinding[] = [];
  const renames = renamesFromStatements(statements);
  for (const [table, was] of before) {
    const renamed = renames.find((rename) => rename.kind === 'table' && lower(rename.from) === lower(table));
    const name = renamed ? renamed.to : table;
    const now = after.get(name) ?? [...after].find(([other]) => lower(other) === lower(name))?.[1];
    // Dropped: said by `db generate` where the schema change is read.
    if (!now) continue;

    const told = was.key.length > 0 && now.rows.size > 0 && was.key.every((column) => now.columns.includes(column));
    const lost = told ? [...was.rows.keys()].filter((key) => !now.rows.has(key)).length : Math.max(0, was.count - now.count);
    if (lost > 0 && !writes(statements, 'DELETE FROM', table) && !writes(statements, 'DELETE FROM', name)) {
      findings.push({
        migration,
        kind: 'loses-rows',
        table: name,
        message: `${lost} of the ${was.count} rows of ${name} are gone after it, and no statement of it deletes them: a rebuild, or a constraint, took them along`,
        fingerprint: `loses-rows:${name}`,
      });
      continue;
    }
    if (!told || writes(statements, 'UPDATE', table) || writes(statements, 'UPDATE', name)) continue;

    for (const column of was.columns) {
      const moved = renames.find((rename) => rename.kind === 'column' && lower(rename.table) === lower(table) && lower(rename.from) === lower(column));
      const columnNow = moved ? moved.to : column;
      // Dropped, like a table: said where the schema change is read.
      if (!now.columns.includes(columnNow)) continue;
      let emptied = 0;
      for (const [key, row] of was.rows) {
        const kept = now.rows.get(key);
        if (kept && row[column] !== null && row[column] !== undefined && (kept[columnNow] === null || kept[columnNow] === undefined)) emptied++;
      }
      if (emptied > 0) {
        findings.push({
          migration,
          kind: 'loses-values',
          table: name,
          column: columnNow,
          message: `${name}.${columnNow} is empty after it in ${emptied} row(s) that held a value before: the rebuild did not copy the column`,
          fingerprint: `loses-values:${name}.${columnNow}`,
        });
      }
    }
  }
  return findings;
}

/** What to do about a failure, by what SQLite said. */
function remedy(error: string): string {
  if (/NOT NULL constraint failed/i.test(error)) return 'a row holds NULL there — give those rows a value in this migration, before the statement: UPDATE … SET … WHERE … IS NULL';
  if (/FOREIGN KEY constraint failed|foreign key mismatch|references a row that is not there/i.test(error)) {
    return 'a row references a row that is not there — remove or repair those rows in this migration, before the statement: add the rows they reference (INSERT INTO … SELECT DISTINCT … WHERE … NOT IN (SELECT …)), or remove the ones that reference nothing (DELETE FROM … WHERE … NOT IN (SELECT …))';
  }
  if (/UNIQUE constraint failed/i.test(error)) return 'two rows hold the same value there — make them distinct, or remove one, in this migration before the statement';
  if (/CHECK constraint failed/i.test(error)) return 'a row does not meet the check — repair those rows in this migration, before the statement';
  return 'it passes on an empty database and fails on one with rows';
}

function transact(db: RowsDatabase, work: () => void): void {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing to roll back: the failure is the one that counts.
    }
    throw error;
  }
}

/** A chunk as the object applies it: its statements in order, the rows that reference a rebuilt table kept through its DROP. */
function applyChunk(sql: Sql, statements: string[], at: { index: number; statement: string }): void {
  const toRun = statements.map((statement, index) => ({ statement, index })).filter(({ statement }) => statement.trim());
  const guard = guardReferencingRows(
    sql,
    toRun.map(({ statement }) => statement),
  );
  toRun.forEach(({ statement, index }, place) => {
    const execute = () => {
      at.index = index;
      at.statement = statement;
      sql.exec(statement);
    };
    if (!guard) return execute();
    at.index = index;
    at.statement = statement;
    guard.run(place, execute);
  });
  guard?.finish();
}

/** Empties every table: what is left is the schema, for a migration that failed on rows to run on. */
function wipe(db: RowsDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of userTables(db)) db.exec(`DELETE FROM ${quote(table)}`);
  db.exec('PRAGMA foreign_keys = ON');
}

const short = (statement: string): string => {
  const line = statement.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
};

/**
 * Replays `migrations`, in order, on a database with rows: before each one,
 * every table gets rows its schema allows; then the migration runs as a
 * Durable Object would run it. What fails, and what takes rows or values
 * along without saying so, is a finding. A migration that fails is run again
 * on the emptied database, so the ones after it are still checked.
 */
export function replayWithRows(Database: RowsDatabaseConstructor, migrations: readonly (readonly [name: string, chunks: string[][]])[]): RowsReplay {
  const db = new Database(':memory:');
  const replay: RowsReplay = { findings: [], unseeded: [] };
  const unseeded = new Map<string, string>();
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const sql = objectSql(db);
    const state = { n: 0 };
    for (const [name, chunks] of migrations) {
      for (const { table, reason } of seed(db, state)) unseeded.set(table, reason);
      const before = snapshot(db);
      const statements = chunks.flat();
      let failed = false;
      for (let chunk = 0; chunk < chunks.length; chunk++) {
        const at = { index: -1, statement: '' };
        try {
          transact(db, () => applyChunk(sql, chunks[chunk]!, at));
        } catch (error) {
          const said = error instanceof Error ? error.message : String(error);
          if (!failed) {
            failed = true;
            replay.findings.push({
              migration: name,
              kind: 'fails',
              chunk,
              statement: at.statement,
              error: said,
              message: `fails on a database that has rows — ${said} (chunk ${chunk}, statement ${at.index}: ${short(at.statement)}): ${remedy(said)}`,
              fingerprint: `fails:${chunk}:${at.index}:${said.replace(/\s+/g, ' ').slice(0, 120)}`,
            });
          }
          // On the schema alone, so the migrations after it meet what they expect.
          wipe(db);
          try {
            transact(db, () => applyChunk(sql, chunks[chunk]!, at));
          } catch (again) {
            replay.stopped = { migration: name, error: again instanceof Error ? again.message : String(again) };
            replay.unseeded = [...unseeded].map(([table, reason]) => ({ table, reason }));
            return replay;
          }
        }
      }
      if (!failed) replay.findings.push(...compare(name, statements, before, snapshot(db)));
    }
  } finally {
    db.close();
  }
  replay.unseeded = [...unseeded].map(([table, reason]) => ({ table, reason }));
  return replay;
}

// ── What was looked at and let through ───────────────────────────────────

/** `<migrations>/<database>/_accepted.json`: the findings someone has looked at and let through, by migration. */
export type Accepted = Record<string, string[]>;

export const ACCEPTED_FILE = '_accepted.json';

/** The findings nobody has accepted, and the ones somebody has. */
export function sift(findings: RowsFinding[], accepted: Accepted): { open: RowsFinding[]; accepted: RowsFinding[] } {
  const open: RowsFinding[] = [];
  const let_through: RowsFinding[] = [];
  for (const finding of findings) (accepted[finding.migration]?.includes(finding.fingerprint) ? let_through : open).push(finding);
  return { open, accepted: let_through };
}

/** `accepted` with these findings added. */
export function accept(accepted: Accepted, findings: RowsFinding[]): Accepted {
  const next: Accepted = { ...accepted };
  for (const finding of findings) {
    const list = new Set(next[finding.migration] ?? []);
    list.add(finding.fingerprint);
    next[finding.migration] = [...list].sort();
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/** The acceptances of a database's migrations; none where the file is not there (or cannot be read as one). */
export function readAccepted(migrationsDir: string): Accepted {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(migrationsDir, ACCEPTED_FILE), 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string')));
  } catch {
    return {};
  }
}

export function writeAccepted(migrationsDir: string, accepted: Accepted): void {
  fs.mkdirSync(migrationsDir, { recursive: true });
  fs.writeFileSync(path.join(migrationsDir, ACCEPTED_FILE), `${JSON.stringify(accepted, null, 2)}\n`);
}
