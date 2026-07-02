export { TestMigrationDO, TestHappyDO, TestKyselyDO } from './test-do';

/**
 * Placeholder worker entry — tests interact with DOs directly via the
 * cloudflare:test API, but wrangler requires a `main` entry.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response('test worker', { status: 200 });
  },
};
