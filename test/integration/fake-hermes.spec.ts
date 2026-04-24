import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/index.js';
import { fakeHermesCommand } from '../fixtures/fake-hermes.js';
import type { CreateBridgeOptions, JSONSchema7 } from '../../src/types.js';

const schema: JSONSchema7 = {
  type: 'object',
  required: ['x'],
  properties: { x: { type: 'number' } },
  additionalProperties: false,
};

function makeBridge(
  hermesEnv: Record<string, string>,
  overrides: Partial<CreateBridgeOptions> = {},
) {
  return createBridge({
    hermesCommand: fakeHermesCommand(),
    hermesEnv,
    defaultTimeoutMs: 3_000,
    sessionBootTimeoutMs: 2_000,
    ...overrides,
  });
}

describe('integration — fake hermes', () => {
  it('happy path returns ok', async () => {
    const bridge = makeBridge({ FAKE_PROMPT_SEQUENCE: '{"x":1}' });

    const env = await bridge.delegate('wf-happy', { prompt: 'go', outputSchema: schema });

    expect(env.status).toBe('ok');
    expect(env.output).toEqual({ x: 1 });

    await bridge.shutdown();
  }, 30_000);

  it('repair path succeeds on second response', async () => {
    const bridge = makeBridge({ FAKE_PROMPT_SEQUENCE: '{"x":"bad"};{"x":2}' });

    const env = await bridge.delegate('wf-repair', { prompt: 'go', outputSchema: schema });

    expect(env.status).toBe('ok');
    expect(env.meta.attempt).toBe(2);
    expect(env.output).toEqual({ x: 2 });

    await bridge.shutdown();
  }, 30_000);

  it('timeout kills the session and the next delegate gets a fresh session', async () => {
    const bridge = makeBridge(
      { FAKE_AWAIT_CANCEL: '1' },
      { defaultTimeoutMs: 250 },
    );

    const first = await bridge.delegate('wf-timeout', { prompt: 'go', outputSchema: schema });
    const second = await bridge.delegate('wf-timeout', { prompt: 'go-again', outputSchema: schema });

    expect(first.status).toBe('timeout');
    expect(second.status).toBe('timeout');
    expect(first.meta.sessionId).toBe(second.meta.sessionId);
    expect(second.meta.reused).toBe(false);
    expect(second.meta.generation).toBe(2);

    await bridge.shutdown();
  }, 30_000);

  it('concurrent workflows use distinct sessions', async () => {
    const bridge = makeBridge(
      { FAKE_PROMPT_SEQUENCE: '{"x":1}' },
      { maxConcurrentSessions: 2 },
    );

    const [a, b] = await Promise.all([
      bridge.delegate('wf-a', { prompt: 'go-a', outputSchema: schema }),
      bridge.delegate('wf-b', { prompt: 'go-b', outputSchema: schema }),
    ]);

    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(a.meta.sessionId).not.toBe(b.meta.sessionId);

    await bridge.shutdown();
  }, 30_000);

  it('reuses the same session for repeated delegates on one workflow', async () => {
    const bridge = makeBridge({ FAKE_PROMPT_SEQUENCE: '{"x":1}' });

    const first = await bridge.delegate('wf-reuse', { prompt: 'first', outputSchema: schema });
    const second = await bridge.delegate('wf-reuse', { prompt: 'second', outputSchema: schema });

    expect(first.status).toBe('ok');
    expect(first.meta.reused).toBe(false);
    expect(first.meta.generation).toBe(1);

    expect(second.status).toBe('ok');
    expect(first.meta.sessionId).toBe(second.meta.sessionId);
    expect(second.meta.reused).toBe(true);
    expect(second.meta.generation).toBe(1);

    await bridge.shutdown();
  }, 30_000);

  it('idle TTL expiry closes the session and the next delegate opens a fresh one', async () => {
    const bridge = makeBridge(
      { FAKE_PROMPT_SEQUENCE: '{"x":1}' },
      { idleTtlMs: 100 },
    );

    const first = await bridge.delegate('wf-idle', { prompt: 'first', outputSchema: schema });
    await new Promise((r) => globalThis.setTimeout(r, 250));
    const second = await bridge.delegate('wf-idle', { prompt: 'second', outputSchema: schema });

    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(first.meta.sessionId).toBe(second.meta.sessionId);
    expect(second.meta.reused).toBe(false);
    expect(second.meta.generation).toBe(2);

    await bridge.shutdown();
  }, 30_000);

  it('shutdown while a delegate is in flight returns cancelled', async () => {
    const bridge = makeBridge(
      { FAKE_AWAIT_CANCEL: '1' },
      { defaultTimeoutMs: 3_000 },
    );

    const pending = bridge.delegate('wf-shutdown', { prompt: 'go', outputSchema: schema });
    globalThis.setTimeout(() => {
      void bridge.shutdown();
    }, 100);

    const env = await pending;

    expect(env.status).toBe('cancelled');
    expect(env.error?.message).toContain('shutting down');
  }, 30_000);

  it('third workflow blocks on semaphore saturation until a session is closed', async () => {
    const bridge = makeBridge(
      { FAKE_PROMPT_SEQUENCE: '{"x":1}' },
      { maxConcurrentSessions: 2 },
    );

    const [a, b] = await Promise.all([
      bridge.delegate('wf-A', { prompt: 'go-a', outputSchema: schema }),
      bridge.delegate('wf-B', { prompt: 'go-b', outputSchema: schema }),
    ]);

    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');

    let resolved = false;
    const pC = bridge.delegate('wf-C', { prompt: 'go-c', outputSchema: schema }).then((env) => {
      resolved = true;
      return env;
    });

    await new Promise((r) => globalThis.setTimeout(r, 20));
    expect(resolved).toBe(false);

    await bridge.close('wf-A');

    const c = await pC;
    expect(c.status).toBe('ok');

    await bridge.shutdown();
  }, 30_000);
});

