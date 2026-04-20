import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/util/mutex.js';

describe('Mutex', () => {
  it('serializes concurrent acquirers', async () => {
    const m = new Mutex();
    const log: string[] = [];

    const task = async (name: string) => {
      const release = await m.acquire();
      log.push(`${name}-start`);
      await new Promise((r) => globalThis.setTimeout(r, 10));
      log.push(`${name}-end`);
      release();
    };

    await Promise.all([task('A'), task('B'), task('C')]);
    expect(log).toEqual([
      'A-start', 'A-end',
      'B-start', 'B-end',
      'C-start', 'C-end',
    ]);
  });

  it('release is idempotent (second call is no-op)', async () => {
    const m = new Mutex();
    const release = await m.acquire();
    release();
    expect(() => release()).not.toThrow();
  });

  it('rejectAll() evicts all queued waiters with given error', async () => {
    const m = new Mutex();
    const held = await m.acquire();
    const err = new Error('evicted');

    const p1 = m.acquire();
    const p2 = m.acquire();

    m.rejectAll(err);

    await expect(p1).rejects.toThrow('evicted');
    await expect(p2).rejects.toThrow('evicted');
    held();
  });
});
