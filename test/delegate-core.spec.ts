import { describe, it, expect, vi } from 'vitest';
import type { JSONSchema7 } from 'json-schema';
import { delegate } from '../src/delegate-core.js';
import type { SessionManager, SessionRecord, SessionHandle } from '../src/session-manager.js';
import type { HermesTransport, PromptStreamEvent } from '../src/transport/types.js';

function makeFakeHandle(...rawTexts: string[]): SessionHandle & { release: ReturnType<typeof vi.fn> } {
  let i = 0;
  const transport: HermesTransport = {
    sessionId: 's-1',
    stderrTail: '',
    prompt: vi.fn(async (
      _text: string,
      opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
    ) => {
      const text = rawTexts[Math.min(i, rawTexts.length - 1)] ?? '';
      i += 1;
      opts.onChunk({ kind: 'message', text });
      return { rawText: text };
    }),
    async awaitCancelAck(_ms: number) { /* noop */ },
    async close() { /* noop */ },
  };
  const session = {
    workflowId: 'wf',
    transport,
    gate: { acquire: vi.fn(), rejectAll: vi.fn() },
    state: 'ready' as const,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    idleTimer: null,
    lifetimeTimer: null,
    onEvicted: null,
    generation: 1,
  } as unknown as SessionRecord;
  return { session, release: vi.fn(), reused: false };
}

function makeFakeManager(handle: SessionHandle): SessionManager {
  return {
    acquire: vi.fn(async () => handle),
    refreshIdle: vi.fn(),
    evictTimeoutKill: vi.fn(async () => { /* noop */ }),
    shutdownSignal: new globalThis.AbortController().signal,
  } as unknown as SessionManager;
}

const schema: JSONSchema7 = {
  type: 'object',
  required: ['x'],
  properties: { x: { type: 'number' } },
  additionalProperties: false,
};

describe('delegate — happy path', () => {
  it('returns ok envelope when response is valid JSON matching schema', async () => {
    const handle = makeFakeHandle('{"x": 1}');
    const mgr = makeFakeManager(handle);

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'do it', outputSchema: schema },
      opts: {},
      defaults: { defaultTimeoutMs: 5000 },
      logger: {},
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.output).toEqual({ x: 1 });
    expect(envelope.meta.attempt).toBe(1);
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it('schema error after repair returns schema_error envelope', async () => {
    const handle = makeFakeHandle('{"x": "not a number"}', '{"x": "still not a number"}');
    const mgr = makeFakeManager(handle);

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'do it', outputSchema: schema },
      opts: {},
      defaults: { defaultTimeoutMs: 5000 },
      logger: {},
    });

    expect(envelope.status).toBe('schema_error');
    expect(envelope.output).toBeNull();
    expect(envelope.meta.attempt).toBe(2);
    expect(handle.session.transport.prompt).toHaveBeenCalledTimes(2);
  });

  it('repair recovers to ok when second attempt validates', async () => {
    const handle = makeFakeHandle('{"x": "bad"}', '{"x": 42}');
    const mgr = makeFakeManager(handle);

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'do it', outputSchema: schema },
      opts: {},
      defaults: { defaultTimeoutMs: 5000 },
      logger: {},
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.output).toEqual({ x: 42 });
    expect(envelope.meta.attempt).toBe(2);
  });
});

function makeHangingTransport(sessionId = 's-1'): HermesTransport {
  const transport = {
    sessionId,
    stderrTail: '',
    awaitCancelAck: vi.fn(async (_ms: number) => { /* noop */ }),
    prompt: vi.fn(async (
      _t: string,
      opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
    ) => {
      await new Promise((_r, reject) => {
        opts.signal.addEventListener(
          'abort',
          () => reject((opts.signal as globalThis.AbortSignal & { reason?: unknown }).reason),
          { once: true },
        );
      });
      return { rawText: '' };
    }),
    async close() { /* noop */ },
  };
  return transport as unknown as HermesTransport;
}

function makeHandleFromTransport(transport: HermesTransport): SessionHandle & { release: ReturnType<typeof vi.fn> } {
  const session = {
    workflowId: 'wf',
    transport,
    gate: { acquire: vi.fn(), rejectAll: vi.fn() },
    state: 'ready' as const,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    idleTimer: null,
    lifetimeTimer: null,
    onEvicted: null,
    generation: 1,
  } as unknown as SessionRecord;
  return { session, release: vi.fn(), reused: false };
}

describe('delegate — timeout and cancel (per-attempt semantics)', () => {
  it('per-attempt timeout returns timeout envelope, calls awaitCancelAck, triggers evictTimeoutKill, session NOT reused', async () => {
    const transport = makeHangingTransport();
    const hangingHandle = makeHandleFromTransport(transport);
    const mgr = {
      acquire: vi.fn(async () => hangingHandle),
      refreshIdle: vi.fn(),
      evictTimeoutKill: vi.fn(async () => { /* noop */ }),
      shutdownSignal: new globalThis.AbortController().signal,
    } as unknown as SessionManager;

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'x', outputSchema: schema },
      opts: { timeoutMs: 50 },
      defaults: { defaultTimeoutMs: 50 },
      logger: {},
    });

    expect(envelope.status).toBe('timeout');
    expect(transport.awaitCancelAck).toHaveBeenCalledWith(1000);
    expect(mgr.evictTimeoutKill).toHaveBeenCalledTimes(1);
    expect(mgr.evictTimeoutKill).toHaveBeenCalledWith(hangingHandle.session);
  });

  it('repair attempt gets a FRESH per-attempt timer (not leftover from attempt 1)', async () => {
    let callIdx = 0;
    const transport = {
      sessionId: 's-1',
      stderrTail: '',
      awaitCancelAck: vi.fn(async (_ms: number) => { /* noop */ }),
      prompt: vi.fn(async (
        _t: string,
        opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
      ) => {
        callIdx += 1;
        if (callIdx === 1) return { rawText: 'not json' };
        await new Promise((_r, reject) => {
          opts.signal.addEventListener(
            'abort',
            () => reject((opts.signal as globalThis.AbortSignal & { reason?: unknown }).reason),
            { once: true },
          );
        });
        return { rawText: '' };
      }),
      async close() { /* noop */ },
    } as unknown as HermesTransport;
    const handle = makeHandleFromTransport(transport);
    const mgr = {
      acquire: vi.fn(async () => handle),
      refreshIdle: vi.fn(),
      evictTimeoutKill: vi.fn(async () => { /* noop */ }),
      shutdownSignal: new globalThis.AbortController().signal,
    } as unknown as SessionManager;

    const t0 = Date.now();
    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'x', outputSchema: schema },
      opts: { timeoutMs: 100 },
      defaults: { defaultTimeoutMs: 100 },
      logger: {},
    });
    const elapsed = Date.now() - t0;

    expect(envelope.status).toBe('timeout');
    expect(envelope.meta.attempt).toBe(2);
    expect(transport.prompt).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('caller signal abort returns cancelled envelope; does NOT trigger evictTimeoutKill', async () => {
    const transport = makeHangingTransport();
    const handle = makeHandleFromTransport(transport);
    const mgr = {
      acquire: vi.fn(async () => handle),
      refreshIdle: vi.fn(),
      evictTimeoutKill: vi.fn(async () => { /* noop */ }),
      shutdownSignal: new globalThis.AbortController().signal,
    } as unknown as SessionManager;

    const ac = new globalThis.AbortController();
    globalThis.setTimeout(() => ac.abort(new Error('bye')), 30);

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'x', outputSchema: schema },
      opts: { signal: ac.signal, timeoutMs: 5000 },
      defaults: { defaultTimeoutMs: 5000 },
      logger: {},
    });

    expect(envelope.status).toBe('cancelled');
    expect(envelope.error?.message).toContain('aborted by caller');
    expect(mgr.evictTimeoutKill).not.toHaveBeenCalled();
  });

  // Real HermesTransportImpl swallows caller/timeout abort and returns partial
  // rawText (Task 11 contract) instead of throwing. delegate-core must still
  // detect the per-attempt timeout post-return and route to timeout envelope.
  it('silent-abort transport: timeout still routes to timeout envelope (not schema_error)', async () => {
    const transport = {
      sessionId: 's-1',
      stderrTail: '',
      awaitCancelAck: vi.fn(async (_ms: number) => { /* noop */ }),
      prompt: vi.fn(async (
        _t: string,
        opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
      ) => {
        await new Promise<void>((resolve) => {
          if (opts.signal.aborted) { resolve(); return; }
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { rawText: '' };
      }),
      async close() { /* noop */ },
    } as unknown as HermesTransport;
    const handle = makeHandleFromTransport(transport);
    const mgr = {
      acquire: vi.fn(async () => handle),
      refreshIdle: vi.fn(),
      evictTimeoutKill: vi.fn(async () => { /* noop */ }),
      shutdownSignal: new globalThis.AbortController().signal,
    } as unknown as SessionManager;

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'x', outputSchema: schema },
      opts: { timeoutMs: 50 },
      defaults: { defaultTimeoutMs: 50 },
      logger: {},
    });

    expect(envelope.status).toBe('timeout');
    expect(transport.awaitCancelAck).toHaveBeenCalledWith(1000);
    expect(mgr.evictTimeoutKill).toHaveBeenCalledTimes(1);
  });

  it('silent-abort transport: caller cancel routes to cancelled envelope', async () => {
    const transport = {
      sessionId: 's-1',
      stderrTail: '',
      awaitCancelAck: vi.fn(async (_ms: number) => { /* noop */ }),
      prompt: vi.fn(async (
        _t: string,
        opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
      ) => {
        await new Promise<void>((resolve) => {
          if (opts.signal.aborted) { resolve(); return; }
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { rawText: '' };
      }),
      async close() { /* noop */ },
    } as unknown as HermesTransport;
    const handle = makeHandleFromTransport(transport);
    const mgr = {
      acquire: vi.fn(async () => handle),
      refreshIdle: vi.fn(),
      evictTimeoutKill: vi.fn(async () => { /* noop */ }),
      shutdownSignal: new globalThis.AbortController().signal,
    } as unknown as SessionManager;

    const ac = new globalThis.AbortController();
    globalThis.setTimeout(() => ac.abort(new Error('bye')), 30);

    const envelope = await delegate({
      manager: mgr,
      workflowId: 'wf',
      subtask: { prompt: 'x', outputSchema: schema },
      opts: { signal: ac.signal, timeoutMs: 5000 },
      defaults: { defaultTimeoutMs: 5000 },
      logger: {},
    });

    expect(envelope.status).toBe('cancelled');
    expect(envelope.error?.message).toContain('aborted by caller');
    expect(mgr.evictTimeoutKill).not.toHaveBeenCalled();
  });
});
