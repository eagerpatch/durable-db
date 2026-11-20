import { describe, expectTypeOf, it } from 'vitest';
import { outboxSink, type OutboxEnvelope, type OutboxSink } from '../../src/db/outbox';

// A sink is handed a frozen list of its own: typed readonly, so chunking it in
// place does not compile, while a sink written against `OutboxEnvelope[]`
// still is one.

describe('the outbox sink', () => {
  it('is handed a readonly list of envelopes', () => {
    expectTypeOf<Parameters<OutboxSink['deliver']>[0]>().toEqualTypeOf<readonly OutboxEnvelope[]>();
    const chunk = (envelopes: Parameters<OutboxSink['deliver']>[0]) =>
      // @ts-expect-error a readonly list has no splice: copy it ([...envelopes]) to chunk it
      envelopes.splice(0, 10);
    void chunk;
  });

  it('takes a sink written against OutboxEnvelope[] as before', () => {
    const deliver = async (envelopes: OutboxEnvelope[]) => {
      void envelopes;
    };
    const sink: OutboxSink = { deliver };
    expectTypeOf(outboxSink(deliver)).toEqualTypeOf<OutboxSink>();
    void sink;
  });
});
