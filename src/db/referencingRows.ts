// Keeps the rows that reference a table through a migration that drops it.
//
// SQLite cannot alter most of a table in place, so a migration rebuilds it:
// create `__new_t`, copy the rows, `DROP TABLE t`, rename `__new_t` to `t` —
// with `PRAGMA foreign_keys=OFF` around it, which is what drizzle-kit
// generates. In a Durable Object that pragma does nothing: foreign keys are
// enforced and stay enforced. So the DROP, which deletes the table's rows
// first, acts on every row that references them: ON DELETE CASCADE deletes
// those rows, SET NULL empties their column, NO ACTION and RESTRICT fail the
// migration.
//
// The guard below takes the place of the pragma. Before a table is dropped
// that the chunk makes again by renaming another into its place, the rows of
// the tables that reference it — and of those that reference them — are moved
// aside, so the DROP finds nothing to act on; once the rename has run they are
// put back, and checked against the table they reference. A DROP of a
// referenced table that nothing replaces is put off to the end of the chunk:
// by then the migration has rebuilt the referencing tables without the
// reference.
//
// A chunk without a `DROP TABLE` gets no guard and runs as it always did. What
// the guard does not cover: a rebuild whose DROP and RENAME are in different
// chunks, one that renames the old table away instead of dropping it, and
// rebuilds woven into each other (`DROP a … DROP b … RENAME → a`).

/** The part of a Durable Object's `SqlStorage` the guard uses. */
export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** What a statement does to the set of tables, as far as the guard cares. */
export type Effect =
  | { kind: 'drop'; table: string }
  | { kind: 'create'; table: string }
  | { kind: 'rename'; from: string; to: string };

const NAME = /^\s*(?:`((?:[^`]|``)*)`|"((?:[^"]|"")*)"|\[([^\]]*)\]|([A-Za-z_][\w$]*))/;

function readName(text: string): { name: string; rest: string } | null {
  const match = NAME.exec(text);
  if (!match) return null;
  const name = match[1]?.replaceAll('``', '`') ?? match[2]?.replaceAll('""', '"') ?? match[3] ?? match[4] ?? '';
  return { name, rest: text.slice(match[0].length) };
}

/** A table's name, with or without a schema in front (`main.t`). */
function readTable(text: string): { name: string; rest: string } | null {
  const first = readName(text);
  if (!first) return null;
  const dot = /^\s*\./.exec(first.rest);
  return dot ? readName(first.rest.slice(dot[0].length)) : first;
}

/** What `statement` drops, creates or renames; null for anything else. */
export function effectOf(statement: string): Effect | null {
  const text = statement.trimStart();

  const drop = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i.exec(text);
  if (drop) {
    const table = readTable(text.slice(drop[0].length));
    return table ? { kind: 'drop', table: table.name } : null;
  }

  const create = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(text);
  if (create) {
    const table = readTable(text.slice(create[0].length));
    return table ? { kind: 'create', table: table.name } : null;
  }

  const alter = /^ALTER\s+TABLE\s+/i.exec(text);
  if (alter) {
    const from = readTable(text.slice(alter[0].length));
    if (!from) return null;
    // `RENAME COLUMN a TO b` and `RENAME a TO b` (a column) have a name before TO.
    const rename = /^\s+RENAME\s+TO\s+/i.exec(from.rest);
    const to = rename && readName(from.rest.slice(rename[0].length));
    return to ? { kind: 'rename', from: from.name, to: to.name } : null;
  }

  return null;
}

const HOLD = '__durable_db_hold_';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const lower = (name: string) => name.toLowerCase();
const rows = (sql: Sql, query: string, ...bindings: unknown[]) => sql.exec(query, ...bindings).toArray();

/** What a pragma that holds a switch answers. */
function isOn(sql: Sql, pragma: string): boolean {
  const [row] = rows(sql, `PRAGMA ${pragma}`);
  return Number(Object.values(row ?? {})[0] ?? 0) !== 0;
}

/**
 * The tables whose rows a DROP of `dropped` would act on: those that reference
 * it, and those that reference them. A table comes before the tables it
 * references.
 */
function dependentsOf(sql: Sql, dropped: string): string[] {
  const tables = rows(sql, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => String(row.name))
    .filter((name) => !/^(sqlite_|_cf_)/i.test(name));
  if (!tables.some((table) => lower(table) === lower(dropped))) return [];

  const references = new Map(
    tables.map((table) => [
      table,
      new Set(rows(sql, `PRAGMA foreign_key_list(${quote(table)})`).map((key) => lower(String(key.table)))),
    ])
  );

  const found: string[] = [];
  const reached = new Set([lower(dropped)]);
  const visit = (parent: string) => {
    for (const table of tables) {
      if (reached.has(lower(table)) || !references.get(table)?.has(lower(parent))) continue;
      reached.add(lower(table));
      // A table without rows has nothing a DROP could act on, and nothing behind it either.
      if (rows(sql, `SELECT 1 FROM ${quote(table)} LIMIT 1`).length === 0) continue;
      visit(table);
      found.push(table);
    }
  };
  visit(dropped);
  return found;
}

/**
 * Runs `work` with no foreign key checked row by row: tables that reference
 * each other are emptied and filled one at a time. Nothing is checked at the
 * end either — whoever fills tables checks them.
 */
function unchecked<T>(sql: Sql, work: () => T): T {
  if (isOn(sql, 'defer_foreign_keys')) return work();
  sql.exec('PRAGMA defer_foreign_keys = ON');
  try {
    return work();
  } finally {
    sql.exec('PRAGMA defer_foreign_keys = OFF');
  }
}

/** A table whose rows are held aside. */
interface Held {
  table: string;
  /** Its columns, quoted, without the generated ones. */
  columns: string;
  /** Its triggers, dropped so that moving the rows runs none of them. */
  triggers: string[];
}

/** Moves the rows of `tables` (a table before the tables it references) aside. */
function hold(sql: Sql, tables: string[]): Held[] {
  return unchecked(sql, () => {
    const held = tables.map((table): Held => {
      const columns = rows(sql, `PRAGMA table_info(${quote(table)})`)
        .map((column) => quote(String(column.name)))
        .join(', ');
      sql.exec(`CREATE TABLE ${quote(HOLD + table)} AS SELECT ${columns} FROM ${quote(table)}`);
      const triggers = rows(sql, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) = lower(?)", table);
      for (const trigger of triggers) sql.exec(`DROP TRIGGER ${quote(String(trigger.name))}`);
      return { table, columns, triggers: triggers.map((trigger) => String(trigger.sql)) };
    });
    // Every row is aside before any is deleted: a delete may reach into another of the tables.
    for (const { table } of held) sql.exec(`DELETE FROM ${quote(table)}`);
    return held;
  });
}

/** Puts the rows back once `renamed.from` has taken the dropped table's place, and checks what they reference. */
function restore(sql: Sql, held: Held[], renamed: { from: string; to: string }): void {
  // The table that took the place may be among them: it references the table it replaces when that one references itself.
  const targetOf = (table: string) => (lower(table) === lower(renamed.from) ? renamed.to : table);
  const filled = [...held].reverse();

  unchecked(sql, () => {
    for (const { table, columns } of filled) {
      sql.exec(`INSERT INTO ${quote(targetOf(table))} (${columns}) SELECT ${columns} FROM ${quote(HOLD + table)}`);
      sql.exec(`DROP TABLE ${quote(HOLD + table)}`);
    }
    for (const { triggers } of filled) for (const trigger of triggers) sql.exec(trigger);
  });

  for (const { table } of filled) {
    const broken = rows(sql, `PRAGMA foreign_key_check(${quote(targetOf(table))})`);
    if (broken.length === 0) continue;
    const parents = [...new Set(broken.map((row) => `"${String(row.parent)}"`))].join(', ');
    throw new Error(
      `[database] ${broken.length} row(s) of "${targetOf(table)}" reference rows of ${parents} that the rebuild of ` +
        `"${renamed.to}" leaves out: the migration has to delete those rows, or point them elsewhere, before it.`
    );
  }
}

/** What stands in for `PRAGMA foreign_keys=OFF` while a chunk of a migration runs. */
export interface ReferenceGuard {
  /** Runs statement `at` through `execute`, keeping the rows that reference a table it drops. */
  run(at: number, execute: () => void): void;
  /** Runs what was put off to the end of the chunk. */
  finish(): void;
}

/**
 * The guard for a chunk's statements (the ones that will run, in order), or
 * null when none of them drops a table.
 */
export function guardReferencingRows(sql: Sql, statements: readonly string[]): ReferenceGuard | null {
  const effects = statements.map(effectOf);
  if (!effects.some((effect) => effect?.kind === 'drop')) return null;

  const same = (a: string, b: string) => lower(a) === lower(b);
  /** The rows held aside, by the place of the RENAME that puts the table they reference back. */
  const aside = new Map<number, { dropped: string; held: Held[] }>();
  const putOff: (() => void)[] = [];
  let enforced: boolean | undefined;

  /** The first statement after `at` that makes a table called `table`. */
  const madeAgain = (table: string, at: number) => {
    for (let next = at + 1; next < effects.length; next++) {
      const effect = effects[next];
      if (effect?.kind === 'create' && same(effect.table, table)) return { at: next, renamed: false };
      if (effect?.kind === 'rename' && same(effect.to, table)) return { at: next, renamed: true };
    }
    return null;
  };

  return {
    run(at, execute) {
      const effect = effects[at];
      if (effect?.kind === 'rename') {
        execute();
        const rows = aside.get(at);
        if (!rows) return;
        aside.delete(at);
        restore(sql, rows.held, effect);
        return;
      }
      // Without enforcement a DROP acts on no other table's rows.
      if (effect?.kind !== 'drop' || !(enforced ??= isOn(sql, 'foreign_keys'))) return execute();

      for (const { dropped, held } of aside.values()) {
        if (!held.some(({ table }) => same(table, effect.table))) continue;
        throw new Error(
          `[database] The migration drops "${effect.table}" in the middle of the rebuild of "${dropped}", which it ` +
            'references: one rebuild has to end (DROP TABLE, then RENAME TO) before the next begins.'
        );
      }

      const again = madeAgain(effect.table, at);
      // Dropped and created anew: its rows are meant to go, and what they take with them.
      if (again && !again.renamed) return execute();
      const dependents = dependentsOf(sql, effect.table);
      if (dependents.length === 0) return execute();
      // Dropped for good: the tables that reference it are rebuilt without the reference further down.
      if (!again) return void putOff.push(execute);

      aside.set(again.at, { dropped: effect.table, held: hold(sql, dependents) });
      execute();
    },
    finish() {
      for (const drop of putOff) drop();
    },
  };
}
