import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A host CLI registers `db` (createDbCommand) for every command line it runs,
// so the BUILT CLI entry loads what registering needs and nothing of drizzle-kit
// (its API loads drizzle-orm's ~240 modules): that is required at the first
// snapshot or migration.
const dist = path.resolve(import.meta.dirname, '../../dist');

/** The packages under node_modules that importing `entry` (then running `then`, given its module as `m`) loads. */
function loadedPackages(entry: string, then = ''): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-db-startup-'));
  try {
    const trace = path.join(dir, 'trace.txt');
    const script = [
      "import { registerHooks } from 'node:module';",
      "import { writeFileSync } from 'node:fs';",
      'const loaded = [];',
      'registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });',
      `const m = await import(${JSON.stringify(entry)});`,
      then,
      `writeFileSync(${JSON.stringify(trace)}, loaded.join('\\n'));`,
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    const packages = new Set<string>();
    for (const url of fs.readFileSync(trace, 'utf-8').split('\n')) {
      const match = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url);
      if (match) packages.add(match[1]!);
    }
    return [...packages];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the CLI entry', () => {
  it('loads no drizzle-kit until a snapshot or migration is made', () => {
    const entry = path.join(dist, 'cli', 'index.js');
    if (!fs.existsSync(entry)) throw new Error('dist/ not found — run `pnpm build` first.');
    const packages = loadedPackages(entry);
    expect(packages).toContain('commander');
    expect(packages).not.toContain('drizzle-kit');
  });

  it('loads it at the first snapshot (the recording is no stub)', () => {
    const snapshot = path.join(dist, 'migrations', 'snapshot.js');
    expect(loadedPackages(snapshot)).not.toContain('drizzle-kit');
    expect(loadedPackages(snapshot, 'await m.generateSnapshotFromSchema({});')).toContain('drizzle-kit');
  });
});
