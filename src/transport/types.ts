import type { BridgeEvent } from '../types.js';

/** Streaming event emitted by transport during a prompt, before final. */
export type PromptStreamEvent =
  | { kind: 'message'; text: string }
  | { kind: 'tool_progress'; name: string; state: 'start' | 'update' | 'end' };

export interface PromptResult {
  rawText: string;
}

export interface HermesTransport {
  /** ACP session id assigned by newSession. */
  readonly sessionId: string;

  /**
   * Send a user prompt, stream events via onChunk, resolve with final raw text.
   * Honors AbortSignal — on abort, sends ACP `cancel` to agent and resolves or rejects
   * with the appropriate error.
   */
  prompt(
    text: string,
    opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
  ): Promise<PromptResult>;

  /** Close ACP session + subprocess. Idempotent. */
  close(): Promise<void>;

  /**
   * After the caller has aborted an in-flight prompt (via the `signal` passed
   * to `prompt()`), optionally wait up to `deadlineMs` for an ACP ack or
   * terminal frame from Flash. Best-effort; resolves even on timeout. Used by
   * delegate-core to honour the "cancel → wait ≤1 s ack → close" protocol on
   * per-attempt timeout (§6 hard protocol).
   */
  awaitCancelAck(deadlineMs: number): Promise<void>;

  /** Current stderr tail (up to 4 KiB, most recent). */
  readonly stderrTail: string;
}

/** Factory: spawn hermes, handshake initialize + newSession, return ready transport. */
export interface TransportFactory {
  open(opts: {
    command: string[];
    env?: Record<string, string>;
    cwd?: string;
    bootTimeoutMs: number;
    sessionId?: string;
  }): Promise<HermesTransport>;
}

export type { BridgeEvent };
