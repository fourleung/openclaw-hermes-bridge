import { Semaphore } from './util/semaphore.js';
import { Mutex } from './util/mutex.js';
import { SessionEvictedError, BridgeShutdownError } from './errors.js';
import type { HermesTransport, TransportFactory } from './transport/types.js';
import type { Logger } from './types.js';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface SessionManagerOptions {
  factory: TransportFactory;
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  maxConcurrentSessions: number;
  idleTtlMs: number;
  maxSessionLifetimeMs: number;
  sessionBootTimeoutMs: number;
  logger: Logger;
}

export type SessionState = 'opening' | 'ready' | 'busy' | 'draining' | 'closing' | 'closed';

export interface SessionRecord {
  workflowId: string;
  transport: HermesTransport;
  gate: Mutex;
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;
  idleTimer: TimerHandle | null;
  lifetimeTimer: TimerHandle | null;
  onEvicted: ((reason: 'timeout-kill' | 'lifetime-drain') => void) | null;
}

export interface SessionHandle {
  session: SessionRecord;
  release(): void;
}

export class SessionManager {
  private readonly registry = new Map<string, Promise<SessionRecord>>();
  private readonly closing = new Set<SessionRecord>();
  private readonly semaphore: Semaphore;
  private shutdown_ = false;
  private readonly shutdownController = new globalThis.AbortController();

  constructor(private readonly opts: SessionManagerOptions) {
    this.semaphore = new Semaphore(opts.maxConcurrentSessions);
  }

  get shutdownSignal(): globalThis.AbortSignal {
    return this.shutdownController.signal;
  }

  async acquire(workflowId: string, signal?: globalThis.AbortSignal): Promise<SessionHandle> {
    if (this.shutdown_) throw new BridgeShutdownError();

    const combined = combineSignals(signal, this.shutdownController.signal);

    let rec: SessionRecord;
    const existing = this.registry.get(workflowId);
    if (existing) {
      rec = await existing;
      if (rec.state === 'closed' || rec.state === 'closing' || rec.state === 'draining') {
        if (this.registry.get(workflowId) === existing) {
          this.registry.delete(workflowId);
        }
        return this.acquire(workflowId, signal);
      }
    } else {
      const p = this.createSession(workflowId, combined);
      this.registry.set(workflowId, p);
      try {
        rec = await p;
      } catch (err) {
        this.registry.delete(workflowId);
        throw err;
      }
    }

    const release = await rec.gate.acquire();
    return { session: rec, release };
  }

  async close(workflowId: string): Promise<void> {
    const entry = this.registry.get(workflowId);
    if (!entry) return;
    this.registry.delete(workflowId);
    const rec = await entry.catch(() => null);
    if (!rec) return;
    await this.closeRecord(rec);
  }

  async shutdown(): Promise<void> {
    if (this.shutdown_) return;
    this.shutdown_ = true;
    this.shutdownController.abort(new BridgeShutdownError());
    this.semaphore.rejectAll(new BridgeShutdownError());

    const settled = await Promise.all(
      [...this.registry.values()].map((p) => p.catch(() => null)),
    );
    const allRecords = [
      ...settled.filter((r): r is SessionRecord => r !== null),
      ...this.closing,
    ];
    this.registry.clear();
    await Promise.allSettled(allRecords.map((r) => this.closeRecord(r)));
  }

  refreshIdle(rec: SessionRecord): void {
    rec.lastActivityAt = Date.now();
    if (rec.state === 'ready' || rec.state === 'busy') {
      this.scheduleIdle(rec);
    }
  }

  async evictTimeoutKill(rec: SessionRecord): Promise<void> {
    if (this.registry.get(rec.workflowId)) this.registry.delete(rec.workflowId);
    this.closing.add(rec);
    rec.gate.rejectAll(new SessionEvictedError('timeout-kill'));
    rec.onEvicted?.('timeout-kill');
    await this.closeRecord(rec);
  }

  private async createSession(workflowId: string, signal: globalThis.AbortSignal): Promise<SessionRecord> {
    const release = await this.semaphore.acquire(signal);
    try {
      const transport = await this.opts.factory.open({
        command: this.opts.command,
        env: this.opts.env,
        cwd: this.opts.cwd,
        bootTimeoutMs: this.opts.sessionBootTimeoutMs,
        sessionId: workflowId,
      });

      const rec: SessionRecord = {
        workflowId,
        transport,
        gate: new Mutex(),
        state: 'ready',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimer: null,
        lifetimeTimer: null,
        onEvicted: null,
      };

      const originalClose = rec.transport.close.bind(rec.transport);
      rec.transport.close = async (): Promise<void> => {
        try { await originalClose(); } finally { release(); }
      };

      this.scheduleIdle(rec);
      this.scheduleLifetime(rec);

      return rec;
    } catch (err) {
      release();
      throw err;
    }
  }

  private scheduleIdle(rec: SessionRecord): void {
    if (rec.idleTimer) globalThis.clearTimeout(rec.idleTimer);
    rec.idleTimer = globalThis.setTimeout(() => {
      void this.closeRecord(rec);
    }, this.opts.idleTtlMs);
  }

  private scheduleLifetime(rec: SessionRecord): void {
    rec.lifetimeTimer = globalThis.setTimeout(() => this.evictLifetime(rec), this.opts.maxSessionLifetimeMs);
  }

  private evictLifetime(rec: SessionRecord): void {
    if (rec.state !== 'ready' && rec.state !== 'busy') return;
    if (this.registry.get(rec.workflowId)) {
      this.registry.delete(rec.workflowId);
    }
    this.closing.add(rec);
    rec.state = 'draining';
    rec.gate.rejectAll(new SessionEvictedError('lifetime-drain'));
    rec.onEvicted?.('lifetime-drain');

    // Safety net: force close after one idle TTL if in-flight delegate never finishes.
    globalThis.setTimeout(() => void this.closeRecord(rec), this.opts.idleTtlMs);
  }

  private async closeRecord(rec: SessionRecord): Promise<void> {
    if (rec.state === 'closed' || rec.state === 'closing') return;
    rec.state = 'closing';
    if (rec.idleTimer) globalThis.clearTimeout(rec.idleTimer);
    if (rec.lifetimeTimer) globalThis.clearTimeout(rec.lifetimeTimer);
    try {
      await rec.transport.close();
    } catch (err) {
      this.opts.logger.warn?.({ err, workflowId: rec.workflowId }, 'transport close failed');
    }
    rec.state = 'closed';
    this.closing.delete(rec);
  }
}

function combineSignals(
  a: globalThis.AbortSignal | undefined,
  b: globalThis.AbortSignal,
): globalThis.AbortSignal {
  if (!a) return b;
  return globalThis.AbortSignal.any([a, b]);
}
