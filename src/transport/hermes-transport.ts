import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type Client,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallStatus,
} from '@agentclientprotocol/sdk';
import type { HermesTransport, PromptResult, PromptStreamEvent, TransportFactory } from './types.js';
import { spawnHermes, type HermesProcess } from './subprocess.js';
import { SessionBootstrapTimeoutError } from '../errors.js';

export interface HermesTransportOptions {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  bootTimeoutMs: number;
}

interface ActivePrompt {
  sessionId: string;
  onChunk: (e: PromptStreamEvent) => void;
  chunks: string[];
  /** Resolves when the underlying ACP prompt() settles (success or rejection). */
  settled: Promise<void>;
}

const TOOL_STATE_MAP: Record<ToolCallStatus, 'start' | 'update' | 'end'> = {
  pending: 'start',
  in_progress: 'update',
  completed: 'end',
  failed: 'end',
};

export class HermesTransportImpl implements HermesTransport {
  public readonly sessionId: string;
  private closed = false;
  private active: ActivePrompt | null = null;

  private constructor(
    private readonly proc: HermesProcess,
    private readonly connection: ClientSideConnection,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
  }

  static async open(opts: HermesTransportOptions): Promise<HermesTransportImpl> {
    const proc = await spawnHermes({ command: opts.command, env: opts.env, cwd: opts.cwd });

    // Hold a reference so the local Client handler can fan-out updates once
    // the transport instance is constructed below.
    const handlerRef: { transport: HermesTransportImpl | null } = { transport: null };

    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as globalThis.WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as globalThis.ReadableStream<Uint8Array>,
    );

    const connection = new ClientSideConnection((_agent: Agent): Client => ({
      async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        throw RequestError.methodNotFound('session/request_permission');
      },
      async sessionUpdate(params: SessionNotification): Promise<void> {
        handlerRef.transport?.dispatchSessionUpdate(params);
      },
    }), stream);

    let bootTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const boot = (async () => {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.newSession({
        cwd: opts.cwd ?? globalThis.process.cwd(),
        mcpServers: [],
      });
      return session.sessionId;
    })();

    const timeout = new Promise<never>((_, reject) => {
      bootTimer = globalThis.setTimeout(
        () => reject(new SessionBootstrapTimeoutError(opts.bootTimeoutMs)),
        opts.bootTimeoutMs,
      );
    });

    let sessionId: string;
    try {
      sessionId = await Promise.race([boot, timeout]);
    } catch (err) {
      await proc.close();
      throw err;
    } finally {
      if (bootTimer) globalThis.clearTimeout(bootTimer);
    }

    const transport = new HermesTransportImpl(proc, connection, sessionId);
    handlerRef.transport = transport;
    return transport;
  }

  private dispatchSessionUpdate(params: SessionNotification): void {
    const active = this.active;
    if (!active || params.sessionId !== active.sessionId) return;

    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content);
        if (text === null) return;
        active.chunks.push(text);
        active.onChunk({ kind: 'message', text });
        return;
      }
      case 'tool_call': {
        active.onChunk({ kind: 'tool_progress', name: update.title, state: 'start' });
        return;
      }
      case 'tool_call_update': {
        const state = update.status ? TOOL_STATE_MAP[update.status] : 'update';
        const name = update.title ?? update.toolCallId;
        active.onChunk({ kind: 'tool_progress', name, state });
        return;
      }
      default:
        return;
    }
  }

  async prompt(
    text: string,
    opts: { onChunk: (e: PromptStreamEvent) => void; signal: globalThis.AbortSignal },
  ): Promise<PromptResult> {
    // Pre-check: if signal already aborted (e.g. shutdown aborted during boot race),
    // don't issue an ACP prompt against a subprocess that may be mid-teardown —
    // connection.prompt() does not reject on stream close, which would hang indefinitely.
    if (opts.signal.aborted) {
      return { rawText: '' };
    }

    const promptText: ContentBlock[] = [{ type: 'text', text }];

    const active: ActivePrompt = {
      sessionId: this.sessionId,
      onChunk: opts.onChunk,
      chunks: [],
      settled: Promise.resolve(),
    };
    this.active = active;

    const onAbort = (): void => {
      // Fire-and-forget: ACP cancel is a JSON-RPC notification. The in-flight
      // prompt() above will settle (typically with stopReason='cancelled')
      // once the agent observes the cancel.
      void this.connection.cancel({ sessionId: this.sessionId }).catch(() => {});
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    const promptCall = this.connection.prompt({ sessionId: this.sessionId, prompt: promptText });
    // `settled` is awaited by awaitCancelAck() — must never reject.
    active.settled = promptCall.then(() => undefined, () => undefined);

    let promptErr: unknown = null;
    try {
      await promptCall;
    } catch (err) {
      promptErr = err;
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      this.active = null;
    }

    // On caller abort, swallow the rejection — stopReason='cancelled' is the
    // expected outcome and the partial rawText is what the caller wants.
    if (promptErr && !opts.signal.aborted) throw promptErr;

    return { rawText: active.chunks.join('') };
  }

  async awaitCancelAck(deadlineMs: number): Promise<void> {
    const active = this.active;
    if (!active) return;
    await Promise.race([
      active.settled,
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, deadlineMs)),
    ]);
  }

  get stderrTail(): string {
    return this.proc.stderrTail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.proc.close();
  }
}

function textOf(content: ContentBlock): string | null {
  return content.type === 'text' ? content.text : null;
}

export const transportFactory: TransportFactory = {
  open: (opts) => HermesTransportImpl.open(opts),
};
