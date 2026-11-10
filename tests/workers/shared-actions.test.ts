import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * A shared action in workerd: registered once (test-do.ts, at module scope),
 * it runs as an action of whichever database is called, on that Durable
 * Object's own SQLite.
 */
interface SharedStub {
  ids(asDatabase: string, add: string[]): Promise<unknown>;
}
interface TestEnv {
  TEST_SHARED_DO: DurableObjectNamespace;
}
const testEnv = env as unknown as TestEnv;

function newStub(): DurableObjectStub & SharedStub {
  return testEnv.TEST_SHARED_DO.get(testEnv.TEST_SHARED_DO.idFromName(`s-${crypto.randomUUID()}`)) as never;
}

describe('shared actions (real workerd)', () => {
  it('run in every database, each with its own data', async () => {
    const billing = await newStub().ids('billing', ['b1', 'b2']);
    const catalog = await newStub().ids('catalog', ['c1']);

    expect(billing).toEqual({ database: 'billing', ids: ['b1', 'b2'] });
    expect(catalog).toEqual({ database: 'catalog', ids: ['c1'] });
  });

  it("give way to a database's own action of the same name", async () => {
    expect(await newStub().ids('shared-own', ['x'])).toBe('own');
  });
});
