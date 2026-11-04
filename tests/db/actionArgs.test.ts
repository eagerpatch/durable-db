import { describe, it, expect } from 'vitest';
import { actionArgsType } from '../../src/db/actionArgs';
import { type } from '../../src/arktypeConfig';

/** Validate like the generated code: the errors, or the validated args. */
function validate(validator: (input: unknown) => unknown, input: unknown) {
  const result = validator(input);
  return result instanceof type.errors ? { errors: result.summary } : { value: result };
}

describe('actionArgsType (the `type` an action\'s args compile with)', () => {
  const schema = { productId: 'string', 'photoKey?': 'string' } as const;

  it('accepts an optional key passed as undefined, as the inferred type does', () => {
    expect(validate(actionArgsType(schema), { productId: 'p1', photoKey: undefined })).toStrictEqual({
      value: { productId: 'p1', photoKey: undefined },
    });
    expect(validate(actionArgsType(schema), { productId: 'p1' })).toStrictEqual({ value: { productId: 'p1' } });
  });

  it('still validates an optional key that is present', () => {
    expect(validate(actionArgsType(schema), { productId: 'p1', photoKey: 7 })).toEqual({
      errors: 'photoKey must be a string or undefined (was 7)',
    });
  });

  it('keeps a required key required, even when its type admits undefined', () => {
    const required = actionArgsType({ id: 'string', note: 'string | undefined' });
    expect(validate(required, { id: 'a', note: undefined })).toStrictEqual({ value: { id: 'a', note: undefined } });
    expect(validate(required, { id: 'a' })).toEqual({ errors: 'note must be a string or undefined (was missing)' });
    expect(validate(actionArgsType(schema), { productId: undefined })).toEqual({
      errors: 'productId must be a string (was undefined)',
    });
  });

  it('accepts undefined for an optional key of a nested object too', () => {
    const nested = actionArgsType({ id: 'string', address: { street: 'string', 'unit?': 'string' } });
    expect(validate(nested, { id: 'a', address: { street: 'Main', unit: undefined } })).toStrictEqual({
      value: { id: 'a', address: { street: 'Main', unit: undefined } },
    });
  });

  it('is a plain object Type: props and JSON Schema work', () => {
    const args = actionArgsType(schema);
    expect(args.props.map((prop) => [prop.key, prop.kind])).toEqual([
      ['productId', 'required'],
      ['photoKey', 'optional'],
    ]);
    expect(args.toJsonSchema()).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        productId: { type: 'string' },
        // `undefined` never appears in JSON: the key is a string when present.
        photoKey: { anyOf: [{ type: 'string' }, { not: {} }] },
      },
      required: ['productId'],
    });
  });

  it('leaves the shared `type` as it is: its optional keys stay exact', () => {
    expect(validate(type(schema), { productId: 'p1', photoKey: undefined })).toEqual({
      errors: 'photoKey must be a string (was undefined)',
    });
  });
});
