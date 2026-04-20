import type { JSONSchema7 } from 'json-schema';

export type { JSONSchema7 };

export interface Logger {
  trace?(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
  info?(obj: object, msg?: string): void;
  warn?(obj: object, msg?: string): void;
  error?(obj: object, msg?: string): void;
}

export interface CreateBridgeOptions {
  hermesCommand?: string[];
  hermesEnv?: Record<string, string>;
  hermesCwd?: string;
  logger?: Logger;
  idleTtlMs?: number;
  maxSessionLifetimeMs?: number;
  maxConcurrentSessions?: number;
  /** Per-attempt wall-clock timeout default (see §6 of spec). */
  defaultTimeoutMs?: number;
  sessionBootTimeoutMs?: number;
}

export interface Subtask {
  prompt: string;
  outputSchema: JSONSchema7;
}

export interface DelegateOptions {
  onEvent?: (evt: BridgeEvent) => void;
  signal?: globalThis.AbortSignal;
  /**
   * Per-attempt wall-clock timeout. Applied independently to the initial
   * attempt and (if it runs) the repair attempt. Does not cover semaphore
   * wait or session boot. Overrides createBridge's defaultTimeoutMs.
   */
  timeoutMs?: number;
}

export type EnvelopeStatus =
  | 'ok'
  | 'schema_error'
  | 'agent_error'
  | 'timeout'
  | 'cancelled';

export interface Envelope<T> {
  status: EnvelopeStatus;
  output: T | null;
  rawText: string;
  meta: { sessionId: string | null; attempt: number; durationMs: number };
  error: { message: string; cause?: unknown } | null;
}

export type BridgeEventBase = {
  workflowId: string;
  sessionId: string | null;
  attempt: number;
};

export type BridgeEvent =
  | (BridgeEventBase & {
      type: 'status';
      phase:
        | 'awaiting_capacity'
        | 'session_open'
        | 'prompt_sent'
        | 'repair_start'
        | 'session_expiring'
        | 'session_close';
    })
  | (BridgeEventBase & { type: 'message'; text: string })
  | (BridgeEventBase & {
      type: 'tool_progress';
      name: string;
      state: 'start' | 'update' | 'end';
    })
  | (BridgeEventBase & { type: 'final'; envelope: Envelope<unknown> })
  | (BridgeEventBase & {
      type: 'error';
      status: Exclude<EnvelopeStatus, 'ok'>;
      message: string;
    });

export interface Bridge {
  delegate<T = unknown>(
    workflowId: string,
    subtask: Subtask,
    opts?: DelegateOptions,
  ): Promise<Envelope<T>>;
  close(workflowId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export const DEFAULTS = {
  hermesCommand: ['hermes', 'acp'] as string[],
  idleTtlMs: 600_000,
  maxSessionLifetimeMs: 3_600_000,
  maxConcurrentSessions: 8,
  defaultTimeoutMs: 180_000,
  sessionBootTimeoutMs: 60_000,
} as const;
