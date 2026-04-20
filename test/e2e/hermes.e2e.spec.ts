import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/index.js';
import type { JSONSchema7 } from 'json-schema';

const E2E =
  globalThis.process.env['OPENCLAW_HERMES_BRIDGE_E2E'] === '1'
  || globalThis.process.env['FLASH_BRIDGE_E2E'] === '1';

describe.skipIf(!E2E)('E2E — real hermes', () => {
  const schema: JSONSchema7 = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string' } },
    additionalProperties: false,
  };

  it('delegate returns valid structured output', async () => {
    const bridge = createBridge({ defaultTimeoutMs: 120_000 });
    const env = await bridge.delegate('wf-e2e-1', {
      prompt: "Return a JSON object with a field 'answer' whose value is the string 'ok'.",
      outputSchema: schema,
    });
    expect(env.status).toBe('ok');
    expect(env.output).toHaveProperty('answer');
    await bridge.shutdown();
  }, 180_000);

  it('workflow-scoped reuse: two delegates hit same session', async () => {
    const bridge = createBridge({ defaultTimeoutMs: 120_000 });
    const a = await bridge.delegate('wf-e2e-2', {
      prompt: 'Return {"answer":"first"}',
      outputSchema: schema,
    });
    const b = await bridge.delegate('wf-e2e-2', {
      prompt: 'Return {"answer":"second"}',
      outputSchema: schema,
    });
    expect(a.meta.sessionId).toBe(b.meta.sessionId);
    await bridge.shutdown();
  }, 240_000);

  it('close + fresh delegate spawns new session', async () => {
    const bridge = createBridge({ defaultTimeoutMs: 120_000 });
    const a = await bridge.delegate('wf-e2e-3', {
      prompt: 'Return {"answer":"a"}',
      outputSchema: schema,
    });
    await bridge.close('wf-e2e-3');
    const b = await bridge.delegate('wf-e2e-3', {
      prompt: 'Return {"answer":"b"}',
      outputSchema: schema,
    });
    expect(a.meta.sessionId).not.toBe(b.meta.sessionId);
    await bridge.shutdown();
  }, 240_000);
});
