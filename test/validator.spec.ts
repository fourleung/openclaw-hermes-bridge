// test/validator.spec.ts
import { describe, it, expect } from 'vitest';
import { compileValidator } from '../src/validator.js';
import type { JSONSchema7 } from 'json-schema';

describe('compileValidator', () => {
  const schema: JSONSchema7 = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string' },
      count: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  };

  it('passes valid input', () => {
    const v = compileValidator(schema);
    const r = v({ name: 'x', count: 2 });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value).toEqual({ name: 'x', count: 2 });
  });

  it('reports all errors for invalid input (allErrors mode)', () => {
    const v = compileValidator(schema);
    const r = v({ name: 123, count: -1, extra: true });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.length).toBeGreaterThanOrEqual(2);
      expect(r.errors.map((e) => e.path)).toEqual(
        expect.arrayContaining([expect.any(String)])
      );
    }
  });

  it('rejects malformed schema at compile time', () => {
    const bad = { type: 'not-a-real-type' } as unknown as JSONSchema7;
    expect(() => compileValidator(bad)).toThrow();
  });
});
