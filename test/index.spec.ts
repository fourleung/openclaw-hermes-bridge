import { describe, it, expect, vi } from 'vitest';
import { createBridge } from '../src/index.js';
import type { TransportFactory, HermesTransport } from '../src/transport/types.js';
import type { CreateBridgeOptions, JSONSchema7 } from '../src/types.js';

function makeFactory(): TransportFactory {
  return {
    open: vi.fn(async () => ({
      sessionId: 's',
      stderrTail: '',
      prompt: vi.fn(async (_t, opts) => {
        opts.onChunk({ kind: 'message', text: '{"x":1}' });
        return { rawText: '{"x":1}' };
      }),
      async awaitCancelAck(_ms: number) {/* noop */},
      async close() {/* noop */},
    } as unknown as HermesTransport)),
  };
}

describe('createBridge', () => {
  const schema: JSONSchema7 = {
    type: 'object',
    required: ['x'],
    properties: { x: { type: 'number' } },
    additionalProperties: false,
  };

  it('delegate returns ok envelope end-to-end', async () => {
    const bridge = createBridge({ __factory: makeFactory() } as unknown as CreateBridgeOptions);
    const env = await bridge.delegate('wf', { prompt: 'go', outputSchema: schema });
    expect(env.status).toBe('ok');
    expect(env.output).toEqual({ x: 1 });
    await bridge.shutdown();
  });

  it('close is idempotent', async () => {
    const bridge = createBridge({ __factory: makeFactory() } as unknown as CreateBridgeOptions);
    await bridge.delegate('wf', { prompt: 'go', outputSchema: schema });
    await bridge.close('wf');
    await bridge.close('wf');
    await bridge.shutdown();
  });

  it('shutdown is idempotent', async () => {
    const bridge = createBridge({ __factory: makeFactory() } as unknown as CreateBridgeOptions);
    await bridge.shutdown();
    await bridge.shutdown();
  });

  it('delegate after shutdown returns agent_error envelope', async () => {
    const bridge = createBridge({ __factory: makeFactory() } as unknown as CreateBridgeOptions);
    await bridge.shutdown();
    const env = await bridge.delegate('wf', { prompt: 'go', outputSchema: schema });
    expect(env.status).toBe('agent_error');
    expect(env.error?.message).toContain('shut down');
  });

  it('uses the renamed env var for hermes command resolution', async () => {
    const open = vi.fn(async () => ({
      sessionId: 's',
      stderrTail: '',
      prompt: vi.fn(async (_t, opts) => {
        opts.onChunk({ kind: 'message', text: '{"x":1}' });
        return { rawText: '{"x":1}' };
      }),
      async awaitCancelAck(_ms: number) {/* noop */},
      async close() {/* noop */},
    } as unknown as HermesTransport));

    const previousNew = globalThis.process.env.OPENCLAW_HERMES_BRIDGE_HERMES_CMD;
    const previousOld = globalThis.process.env.FLASH_BRIDGE_HERMES_CMD;
    globalThis.process.env.OPENCLAW_HERMES_BRIDGE_HERMES_CMD = 'custom-hermes acp';
    globalThis.process.env.FLASH_BRIDGE_HERMES_CMD = 'legacy-hermes acp';

    try {
      const bridge = createBridge({ __factory: { open } } as unknown as CreateBridgeOptions);
      await bridge.delegate('wf', { prompt: 'go', outputSchema: schema });
      expect(open).toHaveBeenCalledWith(expect.objectContaining({
        command: ['custom-hermes', 'acp'],
      }));
      await bridge.shutdown();
    } finally {
      if (previousNew === undefined) delete globalThis.process.env.OPENCLAW_HERMES_BRIDGE_HERMES_CMD;
      else globalThis.process.env.OPENCLAW_HERMES_BRIDGE_HERMES_CMD = previousNew;

      if (previousOld === undefined) delete globalThis.process.env.FLASH_BRIDGE_HERMES_CMD;
      else globalThis.process.env.FLASH_BRIDGE_HERMES_CMD = previousOld;
    }
  });
});
