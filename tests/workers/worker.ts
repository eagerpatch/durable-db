export { TestMigrationDO, TestHappyDO, TestKyselyDO, TestRaceDO, TestDevHandoffDO, TestArgsDO, TestRemovedDatabaseDO, TestOutboxDO, TestGlobalOutboxDO, TestSharedDO } from './test-do';
export { TestRelatedDO } from './related-do';
export { TestAtomicDO, TestAtomicOtherDO } from './atomic-do';

/**
 * Placeholder worker entry — tests interact with DOs directly via the
 * cloudflare:test API, but wrangler requires a `main` entry.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response('test worker', { status: 200 });
  },
};
