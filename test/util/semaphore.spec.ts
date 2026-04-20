import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/util/semaphore.js';

describe('Semaphore', () => {
  it('permits up to N concurrent holders', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    expect(s.available()).toBe(0);
    r1();
    expect(s.available()).toBe(1);
    r2();
    expect(s.available()).toBe(2);
  });

  it('queues waiters beyond capacity', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const started: string[] = [];
    const p2 = s.acquire().then((r) => {
      started.push('p2');
      return r;
    });
    await new Promise((r) => globalThis.setTimeout(r, 10));
    expect(started).toEqual([]);
    r1();
    const r2 = await p2;
    expect(started).toEqual(['p2']);
    r2();
  });

  it('signal abort before acquisition rejects immediately', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const ac = new globalThis.AbortController();
    ac.abort(new Error('aborted'));
    await expect(s.acquire(ac.signal)).rejects.toThrow('aborted');
    r1();
  });

  it('signal abort while queued rejects and does not leak a permit', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const ac = new globalThis.AbortController();
    const p = s.acquire(ac.signal);
    globalThis.setTimeout(() => ac.abort(new Error('timed out')), 5);
    await expect(p).rejects.toThrow('timed out');
    r1();
    expect(s.available()).toBe(1);
  });

  it('rejectAll evicts all waiters', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const p1 = s.acquire();
    const p2 = s.acquire();
    s.rejectAll(new Error('shutting down'));
    await expect(p1).rejects.toThrow('shutting down');
    await expect(p2).rejects.toThrow('shutting down');
    r1();
  });
});
