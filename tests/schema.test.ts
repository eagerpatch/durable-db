import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import * as drizzle from 'drizzle-orm';
import * as schema from '../src/schema';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

// durable-db imports each of Drizzle's values from the module that defines it
// (`drizzle-orm/sqlite-core/table`, `…/columns/text`), never from the indexes
// of 'drizzle-orm' and 'drizzle-orm/sqlite-core': those load the rest of
// Drizzle — about 100 modules, pg-core's vector column among them — at every
// schema load in Node (about 150 ms) and keep them in a worker's bundle.
const dist = path.resolve(import.meta.dirname, '../dist');

/** The drizzle-orm modules that importing the BUILT `entry` loads, as paths inside the package. */
function drizzleModules(entry: string): string[] {
  const script = [
    "import { registerHooks } from 'node:module';",
    'const loaded = [];',
    'registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });',
    `await import(${JSON.stringify(entry)});`,
    "console.log(JSON.stringify(loaded));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as string[]).flatMap((url) => {
    const match = /\/node_modules\/drizzle-orm\/(.*)$/.exec(url);
    return match ? [match[1]!] : [];
  });
}

describe("Drizzle's modules", () => {
  it.each(['schema.js', 'index.js'])('dist/%s loads neither index', (file) => {
    const entry = path.join(dist, file);
    if (!fs.existsSync(entry)) throw new Error('dist/ not found — run `pnpm build` first.');
    const modules = drizzleModules(entry);
    expect(modules).toContain('sqlite-core/table.js');
    expect(modules).not.toContain('index.js');
    expect(modules).not.toContain('sqlite-core/index.js');
  });

  it("dist/schema.js loads no SQL builders (they bring pg-core's columns)", () => {
    const modules = drizzleModules(path.join(dist, 'schema.js'));
    expect(modules).not.toContain('sql/index.js');
    expect(modules.filter((m) => m.startsWith('pg-core/columns/vector_extension/'))).toEqual([]);
  });

  it('are the same values the indexes export', () => {
    for (const name of ['text', 'integer', 'real', 'blob', 'numeric', 'index', 'uniqueIndex', 'foreignKey', 'primaryKey'] as const) {
      expect(schema[name], name).toBe(sqliteCore[name]);
    }
    // What the runtime takes from them, through the deep paths, is the indexes' too.
    expect(getTableConfig).toBe(sqliteCore.getTableConfig);
    expect(SQLiteSyncDialect).toBe(sqliteCore.SQLiteSyncDialect);
    const users = schema.table('userProfiles', { id: schema.text().primaryKey() });
    expect(drizzle.is(users, drizzle.Table)).toBe(true);
    expect(drizzle.getTableName(users)).toBe('user_profiles');
  });
});
