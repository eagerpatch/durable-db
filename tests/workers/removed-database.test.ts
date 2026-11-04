import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { RemovedDatabaseDurableObject } from '../../src/db/RemovedDatabaseDurableObject';

/**
 * The tombstone of a removed database's class, in real workerd: it
 * instantiates (so a worker whose migrations still declare the class starts),
 * keeps the storage untouched and refuses every call.
 */
interface RemovedEnv {
  TEST_REMOVED_DO: DurableObjectNamespace & {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => DurableObjectStub;
  };
}

describe('removed database tombstone (real workerd)', () => {
  it('answers fetch with 410 and RPC with an error naming the deleted_classes migration, keeping the data', async () => {
    const ns = (env as unknown as RemovedEnv).TEST_REMOVED_DO;
    const stub = ns.get(ns.idFromName(`r-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE kept (id TEXT PRIMARY KEY)');
      state.storage.sql.exec("INSERT INTO kept (id) VALUES ('a')");
    });

    const response = await stub.fetch('https://do/anything');
    expect(response.status).toBe(410);
    const body = await response.text();
    expect(body).toContain('TestRemovedDatabaseDO');
    expect(body).toContain('{"tag":"v2","deleted_classes":["TestRemovedDatabaseDO"]}');

    // Called inside the Durable Object: a rejection crossing the test pool's
    // RPC wrapper is reported as unhandled even when the test awaits it.
    const errors = await runInDurableObject(stub, async (instance: RemovedDatabaseDurableObject) => {
      const message = (call: Promise<unknown>) => call.then(() => null, (error: Error) => `${error.name}: ${error.message}`);
      return [await message(instance.rpc('listUsers', {})), await message(instance.sys('destroyDatabase'))];
    });
    for (const error of errors) {
      expect(error).toMatch(
        /^RemovedDatabaseError: TestRemovedDatabaseDO is the Durable Object of a removed database[\s\S]*\{"tag":"v2","deleted_classes":\["TestRemovedDatabaseDO"\]\}$/
      );
    }

    const rows = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec('SELECT id FROM kept').toArray()
    );
    expect(rows).toEqual([{ id: 'a' }]);
  });
});
