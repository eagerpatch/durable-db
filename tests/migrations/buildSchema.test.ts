import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAndLoadSchema } from '../../src/migrations/generator';

// esbuild prints from its own process, past any spy: what it is told is what is checked.
vi.mock('esbuild', async (original) => {
  const esbuild = await original<typeof import('esbuild')>();
  return { ...esbuild, build: vi.fn(esbuild.build) };
});

const dirs: string[] = [];
const schemaFile = (source: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-db-schema-'));
  dirs.push(dir);
  const file = path.join(dir, 'schema.ts');
  fs.writeFileSync(file, source);
  return file;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildAndLoadSchema', () => {
  it('throws what does not build with esbuild’s reason, and has esbuild print nothing of its own', async () => {
    const { build } = await import('esbuild');

    await expect(buildAndLoadSchema(schemaFile("import { gone } from './not-there';\nexport const t = gone;\n"), ['t'])).rejects.toThrow(
      /Could not resolve "\.\/not-there"/,
    );
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ logLevel: 'silent' }));
  });
});
