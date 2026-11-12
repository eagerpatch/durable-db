import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

interface RelatedStub {
  read(): Promise<{
    rows: { number: number; customer: string; referee: { name: string } | null; lines: string[] }[];
    vip: unknown;
    createdAt: string;
    delivered: unknown[];
    deliveredAt: unknown[];
  }>;
  nested(): Promise<{ customer: unknown; queries: number }>;
  filtered(): Promise<unknown>;
  afterCascade(): Promise<unknown>;
}

interface TestEnv {
  TEST_RELATED_DO: {
    idFromName(name: string): unknown;
    get(id: unknown): RelatedStub;
  };
}

const testEnv = env as unknown as TestEnv;

// One object per case: each seeds its own rows.
function newStub() {
  const id = testEnv.TEST_RELATED_DO.idFromName(`r-${crypto.randomUUID()}`);
  return testEnv.TEST_RELATED_DO.get(id);
}

describe('related() in a Durable Object', () => {
  it('reads one and many along the foreign keys, ordered and limited', async () => {
    const { rows } = await newStub().read();

    expect(rows).toEqual([
      { number: 1, customer: 'Bolaget AB', referee: { name: 'Firman HB' }, lines: ['Setup', 'Travel'] },
      { number: 2, customer: 'Bolaget AB', referee: null, lines: [] },
    ]);
  });

  it('answers a date and a boolean inside a relation as the columns say', async () => {
    const answer = await newStub().read();

    expect(answer.vip).toBe(true);
    expect(answer.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(answer.delivered).toEqual([true, false]);
    expect(answer.deliveredAt).toEqual(['2026-05-02T10:00:00.000Z', null]);
  });

  it('reads three levels in one query', async () => {
    const { customer, queries } = await newStub().nested();

    expect(queries).toBe(1);
    expect(customer).toEqual({
      name: 'Bolaget AB',
      invoicesAsCustomer: [
        {
          number: 1,
          invoiceLines: [{ description: 'Hours' }, { description: 'Travel' }, { description: 'Setup' }],
          referee: { name: 'Firman HB' },
        },
        { number: 2, invoiceLines: [], referee: null },
      ],
    });
  });

  it('reads the rows of a many that meet a condition, the same relation filtered two ways', async () => {
    expect(await newStub().filtered()).toEqual([
      { number: 1, open: [{ description: 'Travel' }], delivered: [{ description: 'Setup' }] },
      { number: 2, open: [], delivered: [] },
    ]);
  });

  it('reads what the foreign keys leave: a deleted invoice takes its lines along', async () => {
    expect(await newStub().afterCascade()).toEqual({
      id: 'c1',
      invoicesAsCustomer: [{ id: 'i2', invoiceLines: [] }],
    });
  });
});
