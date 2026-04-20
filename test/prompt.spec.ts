import { describe, it, expect } from 'vitest';
import { buildInitialPrompt, buildRepairPrompt } from '../src/prompt.js';
import type { JSONSchema7 } from 'json-schema';

describe('prompt builders', () => {
  const schema: JSONSchema7 = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };

  it('initial prompt appends schema instruction block', () => {
    const out = buildInitialPrompt('Decompose the goal.', schema);
    expect(out).toContain('Decompose the goal.');
    expect(out).toContain('You MUST respond with a single JSON object');
    expect(out).toContain('"x"');
    expect(out).toContain('"number"');
  });

  it('repair prompt lists ajv errors and demands ONLY corrected JSON', () => {
    const out = buildRepairPrompt([
      { path: '/x', message: 'must be number' },
      { path: '(root)', message: 'must have required property \'x\'' },
    ]);
    expect(out).toContain('failed schema validation');
    expect(out).toContain('/x: must be number');
    expect(out).toContain('must have required property');
    expect(out).toContain('ONLY the corrected JSON');
  });
});
