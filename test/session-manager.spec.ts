import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { HermesTransport, TransportFactory } from '../src/transport/types.js';

function fakeTransport(sessionId = 's1'): HermesTransport {
  return {
    sessionId,
    stderrTail: '',
    async prompt(_text, opts) {
      opts.onChunk({ kind: 'message', text: 'ok' });
      return { rawText: 'ok' };
    },
    async awaitCancelAck(_ms) { /* no cancel in this fake */ },
    async close() { /* no-op */ },
  } as HermesTransport;
}

function fakeFactory(): TransportFactory {
  return {
    open: vi.fn(async () => fakeTransport('s-' + Math.random().toString(36).slice(2, 6))),
  };
}

describe('SessionManager', () => {
  it('concurrent acquire for same workflow spawns only one transport', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 4,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });

    // Fire 3 acquires concurrently to exercise the registry-race; release each
    // handle as it resolves so the per-session Mutex can pass to the next waiter
    // (max_concurrent_delegates_per_session = 1, Hard Rule #6).
    const sessions = await Promise.all(
      ['wf-A', 'wf-A', 'wf-A'].map(async (id) => {
        const h = await mgr.acquire(id);
        try { return h.session; } finally { h.release(); }
      }),
    );

    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[1]).toBe(sessions[2]);
    expect(factory.open).toHaveBeenCalledTimes(1);

    await mgr.shutdown();
  });

  it('9th concurrent workflow blocks until a session closes', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 2,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });

    const a = await mgr.acquire('wf-A');
    const b = await mgr.acquire('wf-B');
    let cResolved = false;
    const pC = mgr.acquire('wf-C').then((h) => { cResolved = true; return h; });
    await new Promise((r) => globalThis.setTimeout(r, 20));
    expect(cResolved).toBe(false);

    a.release();
    await mgr.close('wf-A');
    const c = await pC;
    expect(cResolved).toBe(true);

    b.release(); c.release();
    await mgr.shutdown();
  });

  it('shutdown aborts pending semaphore waiters', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 1,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });

    const a = await mgr.acquire('wf-A');
    const pB = mgr.acquire('wf-B');
    globalThis.setTimeout(() => void mgr.shutdown(), 20);
    await expect(pB).rejects.toThrow();
    a.release();
  });

  it('post-shutdown acquire rejects with BridgeShutdownError', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 1,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });
    await mgr.shutdown();
    await expect(mgr.acquire('wf-A')).rejects.toThrow('bridge is shut down');
  });

  it('idle TTL closes session after inactivity', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 2,
      idleTtlMs: 50,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });
    const h = await mgr.acquire('wf-A');
    h.release();
    await new Promise((r) => globalThis.setTimeout(r, 120));
    expect(h.session.state).toBe('closed');
    await mgr.shutdown();
  });

  it('refreshIdle extends TTL', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 2,
      idleTtlMs: 80,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });
    const h = await mgr.acquire('wf-A');
    h.release();
    await new Promise((r) => globalThis.setTimeout(r, 40));
    mgr.refreshIdle(h.session);
    await new Promise((r) => globalThis.setTimeout(r, 50));
    expect(h.session.state).not.toBe('closed');
    await mgr.shutdown();
  });

  it('lifetime drain evicts queued delegates via SessionEvictedError', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 2,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 50,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });
    const h = await mgr.acquire('wf-A');
    const p2 = mgr.acquire('wf-A');
    p2.catch(() => { /* attach early handler to silence late-await warning */ });
    await new Promise((r) => globalThis.setTimeout(r, 80));
    await expect(p2).rejects.toThrow('session evicted');

    h.release();
    await new Promise((r) => globalThis.setTimeout(r, 20));
    const h3 = await mgr.acquire('wf-A');
    expect(h3.session).not.toBe(h.session);
    h3.release();
    await mgr.shutdown();
  });

  it('acquire for different workflows spawns distinct transports', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 4,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });

    const a = await mgr.acquire('wf-A');
    const b = await mgr.acquire('wf-B');
    expect(a.session).not.toBe(b.session);
    expect(factory.open).toHaveBeenCalledTimes(2);
    a.release(); b.release();
    await mgr.shutdown();
  });

  it('retries acquire if existing session in registry is stale', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 4,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });

    const a = await mgr.acquire('wf-A');
    a.session.state = 'closing';
    const b = await mgr.acquire('wf-A');
    expect(b.session).not.toBe(a.session);
    a.release();
    b.release();
    await mgr.shutdown();
  });

  it('createSession factory error propagates', async () => {
    const factory = {
      open: vi.fn().mockRejectedValue(new Error('factory boom')),
    };
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 4,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });

    await expect(mgr.acquire('wf-boom')).rejects.toThrow('factory boom');
  });

  it('closeRecord logs warning if transport.close throws', async () => {
    const factory: TransportFactory = {
      open: vi.fn().mockResolvedValue({
        sessionId: 's-warn',
        stderrTail: '',
        prompt: vi.fn(),
        awaitCancelAck: vi.fn(),
        close: vi.fn().mockRejectedValue(new Error('close boom')),
      }),
    };
    const warnMock = vi.fn();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 4,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: { warn: warnMock },
    });

    const a = await mgr.acquire('wf-A');
    a.release();
    await mgr.close('wf-A');
    expect(warnMock).toHaveBeenCalled();
    expect(warnMock.mock.calls[0][1]).toContain('transport close failed');
  });

  it('evictLifetime does nothing if state is not ready/busy', async () => {
    const factory = fakeFactory();
    const mgr = new SessionManager({
      factory,
      command: ['hermes', 'acp'],
      maxConcurrentSessions: 4,
      idleTtlMs: 60_000,
      maxSessionLifetimeMs: 60_000,
      sessionBootTimeoutMs: 5_000,
      logger: {},
    });
    const a = await mgr.acquire('wf-A');
    a.session.state = 'closing';
    // @ts-expect-error access private method for testing
    mgr.evictLifetime(a.session);
    expect(a.session.state).toBe('closing');
    a.release();
    await mgr.shutdown();
  });
});
