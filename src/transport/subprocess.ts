import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Buffer } from 'node:buffer';
import nodeProcess from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { HermesNotFoundError } from '../errors.js';

const STDERR_TAIL_BYTES = 4096;
const SIGTERM_GRACE_MS = 2000;

type Signals = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT' | string;
type ErrnoError = Error & { code?: string };

export interface SpawnOptions {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HermesProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderrTail: string;
  readonly exited: Promise<{ code: number | null; signal: Signals | null }>;
  close(): Promise<void>;
}

export async function spawnHermes(opts: SpawnOptions): Promise<HermesProcess> {
  const [cmd, ...args] = opts.command;
  if (!cmd) throw new Error('spawnHermes: empty command');

  const envMerged = { ...nodeProcess.env, ...(opts.env ?? {}) };

  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawn(cmd, args, {
      env: envMerged,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if ((err as ErrnoError).code === 'ENOENT') {
      throw new HermesNotFoundError(opts.command);
    }
    throw err;
  }

  // Attach stderr listener BEFORE awaiting spawn — Node streams are paused until
  // first 'data' listener attaches; attaching late after a microtask hop can
  // miss the first chunk on fast-writing children.
  let stderrBuf = Buffer.alloc(0);
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf = Buffer.concat([stderrBuf, chunk]);
    if (stderrBuf.length > STDERR_TAIL_BYTES) {
      stderrBuf = stderrBuf.subarray(stderrBuf.length - STDERR_TAIL_BYTES);
    }
  });

  const errorOnSpawn = new Promise<Error | null>((resolve) => {
    const onError = (err: ErrnoError) => {
      if (err.code === 'ENOENT') resolve(new HermesNotFoundError(opts.command));
      else resolve(err);
    };
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener('error', onError);
      resolve(null);
    });
  });
  const spawnErr = await Promise.race([
    errorOnSpawn,
    new Promise<null>((r) => globalThis.setTimeout(() => r(null), 100)),
  ]);
  if (spawnErr) throw spawnErr;

  const exited = new Promise<{ code: number | null; signal: Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((r) => globalThis.setTimeout(() => r(false), SIGTERM_GRACE_MS)),
    ]);
    if (!graceful) {
      child.kill('SIGKILL');
      await exited;
    }
  };

  return {
    get stdin() { return child.stdin; },
    get stdout() { return child.stdout; },
    get stderrTail() { return stderrBuf.toString('utf8'); },
    exited,
    close,
  };
}
