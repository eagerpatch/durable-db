import { describe, expect, it } from 'vitest';
import { defineDatabase, describeAction, type } from '../../src/index';
import { registerAction } from '../../src/registry';
import { table, text } from '../../src/schema';

const users = table('users', { id: text().primaryKey(), name: text().notNull() });

describe('describeAction', () => {
  it('describes an untransformed action by its compiled args schema', () => {
    const { action } = defineDatabase({ schema: { users } });
    const addUser = action({ args: { id: 'string', 'name?': 'string' }, handler: async () => {} });

    const description = describeAction(addUser);

    expect(description).toMatchObject({ database: null, name: null });
    // An optional key admits undefined, which JSON Schema writes as `{ not: {} }`.
    expect(description!.args!.toJsonSchema()).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, name: { anyOf: [{ type: 'string' }, { not: {} }] } },
      required: ['id'],
    });
  });

  it('describes a compiled call site by what it was registered with', () => {
    const args = type({ id: 'string' });
    async function addUser(_args: { id: string }): Promise<void> {}
    registerAction('describeDb', 'addUser', { validator: (input) => args(input), handler: async () => {}, args, stub: addUser });

    expect(describeAction(addUser)).toEqual({ database: 'describeDb', name: 'addUser', args });
  });

  it('keeps the description off the keys of the call site', () => {
    async function quiet(): Promise<void> {}
    registerAction('describeDb', 'quiet', { validator: (input) => input, handler: async () => {}, stub: quiet });

    expect(Object.keys(quiet)).toEqual([]);
  });

  it('answers undefined for anything that is not an action', () => {
    expect(describeAction(() => {})).toBeUndefined();
    expect(describeAction({})).toBeUndefined();
    expect(describeAction(null)).toBeUndefined();
  });
});
