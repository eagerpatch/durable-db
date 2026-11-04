import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * An optional action arg passed as `undefined` — `addReview({ …, photoKey })`
 * with no photo — type-checks (`{ photoKey?: string }`), so it must validate
 * too: in the RPC stub and in the Durable Object, at request time in workerd.
 */
interface ArgsEnv {
  TEST_ARGS_DO: DurableObjectNamespace & {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => DurableObjectStub & {
      optionalKeyUndefined: () => Promise<{ stub: unknown; durableObject: unknown; rejected: string }>;
    };
  };
}

describe('action args (real workerd)', () => {
  it('accept an optional key given as undefined and drop it, and still reject a wrong type', async () => {
    const ns = (env as unknown as ArgsEnv).TEST_ARGS_DO;
    const result = await ns.get(ns.idFromName(`a-${crypto.randomUUID()}`)).optionalKeyUndefined();
    expect(result.stub).toEqual({ productId: 'p1' });
    expect(result.durableObject).toEqual({ productId: 'p1' });
    expect(result.rejected).toMatch(/photoKey must be a string/);
  });
});
