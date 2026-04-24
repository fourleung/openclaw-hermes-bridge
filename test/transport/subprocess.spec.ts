import { describe, it, expect } from 'vitest';
import { spawnHermes } from '../../src/transport/subprocess.js';
import { HermesNotFoundError } from '../../src/errors.js';

describe('spawnHermes', () => {
  it('throws HermesNotFoundError when binary missing', async () => {
    await expect(
      spawnHermes({ command: ['definitely-not-a-real-binary-xyz'] }),
    ).rejects.toBeInstanceOf(HermesNotFoundError);
  });

  it('spawns node -e and captures stderr tail', async () => {
    const proc = await spawnHermes({
      command: ['node', '-e', 'process.stderr.write("hello err"); setTimeout(()=>{},10000)'],
    });
    for (let i = 0; i < 20; i++) {
      if (proc.stderrTail.includes('hello err')) break;
      await new Promise((r) => globalThis.setTimeout(r, 100));
    }
    expect(proc.stderrTail).toContain('hello err');
    await proc.close();
  });

  it('stderrTail caps at 4 KiB', async () => {
    const big = 'x'.repeat(10_000);
    const proc = await spawnHermes({
      command: ['node', '-e', `process.stderr.write("${big}"); setTimeout(()=>{},10000)`],
    });
    for (let i = 0; i < 20; i++) {
      if (proc.stderrTail.length > 0) break;
      await new Promise((r) => globalThis.setTimeout(r, 100));
    }
    expect(proc.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(proc.stderrTail.length).toBeGreaterThan(0);
    await proc.close();
  });

  it('merges hermesEnv with process.env (explicit wins)', async () => {
    const proc = await spawnHermes({
      command: ['node', '-e', 'process.stderr.write(process.env.FBK_TEST||"unset");setTimeout(()=>{},10000)'],
      env: { FBK_TEST: 'custom-value' },
    });
    for (let i = 0; i < 20; i++) {
      if (proc.stderrTail.includes('custom-value')) break;
      await new Promise((r) => globalThis.setTimeout(r, 100));
    }
    expect(proc.stderrTail).toContain('custom-value');
    await proc.close();
  });

  it('close() sends SIGTERM and escalates to SIGKILL', async () => {
    const proc = await spawnHermes({
      command: ['node', '-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
    });
    // Wait for node to register the SIGTERM handler before sending SIGTERM,
    // otherwise the default handler kills the child immediately.
    await new Promise((r) => globalThis.setTimeout(r, 300));
    const start = Date.now();
    await proc.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(3500);
  }, 5000);
});
