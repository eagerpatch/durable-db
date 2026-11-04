import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};

/** The majors a `^A.0.0 || ^B.0.0` range admits. */
function caretMajors(range: string): number[] {
  return range.split('||').map((part) => {
    const match = /^\s*\^(\d+)\.\d+\.\d+\s*$/.exec(part);
    if (!match) throw new Error(`Unexpected range part: ${part}`);
    return Number(match[1]);
  });
}

describe('package.json', () => {
  it('admits the Vite major the plugin is built and tested with (no unmet peer warning)', () => {
    const require = createRequire(path.join(root, 'package.json'));
    const vite = JSON.parse(fs.readFileSync(require.resolve('vite/package.json'), 'utf-8')) as { version: string };
    const major = Number(vite.version.split('.')[0]);

    expect(caretMajors(pkg.peerDependencies.vite)).toContain(major);
    expect(caretMajors(pkg.peerDependencies.vite)).toContain(8);
  });

  it('lists jsonc-parser, which the wrangler config editing imports at runtime', () => {
    expect(pkg.dependencies['jsonc-parser']).toBeDefined();
  });
});
