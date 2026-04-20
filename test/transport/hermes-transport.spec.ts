import { describe, it, expect } from 'vitest';
import { HermesTransportImpl, transportFactory } from '../../src/transport/hermes-transport.js';
import { SessionBootstrapTimeoutError } from '../../src/errors.js';
import type { PromptStreamEvent } from '../../src/transport/types.js';

/**
 * Fake hermes server, executed as a child via `node -e`. Speaks newline-delimited
 * JSON-RPC 2.0 on stdio matching what `@agentclientprotocol/sdk`'s ndJsonStream
 * expects. Behaviour is parameterised through environment variables so tests can
 * pick the scenario without rewriting the script.
 *
 *   FAKE_HANG_INITIALIZE=1   never reply to `initialize`
 *   FAKE_PROMPT_CHUNKS=...   JSON array of {text} message chunks to emit
 *   FAKE_PROMPT_TOOLS=1      emit a tool_call + tool_call_update sequence
 *   FAKE_AWAIT_CANCEL=1      block prompt response until session/cancel arrives
 */
const FAKE_HERMES_SCRIPT = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
let cancelled = false;
let pendingPromptId = null;
let pendingChunks = [];

function maybeFinishPrompt(stopReason) {
  if (pendingPromptId === null) return;
  send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason } });
  pendingPromptId = null;
}

async function emitChunks(sessionId) {
  for (const c of pendingChunks) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: c.text },
        },
      },
    });
    await new Promise((r) => setImmediate(r));
  }
  pendingChunks = [];
}

async function emitToolCalls(sessionId) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read_file',
        kind: 'read',
        status: 'pending',
      },
    },
  });
  await new Promise((r) => setImmediate(r));
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        title: 'read_file',
        status: 'in_progress',
      },
    },
  });
  await new Promise((r) => setImmediate(r));
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        title: 'read_file',
        status: 'completed',
      },
    },
  });
}

process.stdin.on('data', async (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.method === 'initialize') {
      if (process.env.FAKE_HANG_INITIALIZE) continue;
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    } else if (msg.method === 'session/prompt') {
      pendingPromptId = msg.id;
      const sessionId = msg.params.sessionId;
      const chunkSpec = process.env.FAKE_PROMPT_CHUNKS;
      pendingChunks = chunkSpec ? JSON.parse(chunkSpec) : [];
      await emitChunks(sessionId);
      if (process.env.FAKE_PROMPT_TOOLS) await emitToolCalls(sessionId);
      if (cancelled) { maybeFinishPrompt('cancelled'); continue; }
      if (process.env.FAKE_AWAIT_CANCEL) {
        // wait for cancel
      } else {
        maybeFinishPrompt('end_turn');
      }
    } else if (msg.method === 'session/cancel') {
      cancelled = true;
      maybeFinishPrompt('cancelled');
    }
  }
});
process.on('SIGTERM', () => process.exit(0));
`;

function fakeCommand(): string[] {
  return ['node', '-e', FAKE_HERMES_SCRIPT];
}

describe('HermesTransportImpl', () => {
  it('happy path: initialize + newSession + prompt returns rawText', async () => {
    const transport = await transportFactory.open({
      command: fakeCommand(),
      env: { FAKE_PROMPT_CHUNKS: JSON.stringify([{ text: 'hello ' }, { text: 'world' }]) },
      bootTimeoutMs: 5000,
    });
    expect(transport.sessionId).toBe('sess-1');

    const events: PromptStreamEvent[] = [];
    const ac = new globalThis.AbortController();
    const result = await transport.prompt('hi', {
      onChunk: (e) => events.push(e),
      signal: ac.signal,
    });

    expect(result.rawText).toBe('hello world');
    expect(events).toEqual([
      { kind: 'message', text: 'hello ' },
      { kind: 'message', text: 'world' },
    ]);

    await transport.close();
  }, 10000);

  it('abort signal sends ACP cancel and prompt resolves', async () => {
    const transport = await transportFactory.open({
      command: fakeCommand(),
      env: {
        FAKE_AWAIT_CANCEL: '1',
        FAKE_PROMPT_CHUNKS: JSON.stringify([{ text: 'partial' }]),
      },
      bootTimeoutMs: 5000,
    });

    const events: PromptStreamEvent[] = [];
    const ac = new globalThis.AbortController();
    const promptPromise = transport.prompt('hi', {
      onChunk: (e) => events.push(e),
      signal: ac.signal,
    });

    // give the fake time to emit the chunk before we cancel
    await new Promise((r) => globalThis.setTimeout(r, 100));
    ac.abort();

    const result = await promptPromise;
    expect(result.rawText).toBe('partial');

    await transport.awaitCancelAck(500);
    await transport.close();
  }, 10000);

  it('tool_call updates emit tool_progress events', async () => {
    const transport = await transportFactory.open({
      command: fakeCommand(),
      env: { FAKE_PROMPT_TOOLS: '1' },
      bootTimeoutMs: 5000,
    });

    const events: PromptStreamEvent[] = [];
    const ac = new globalThis.AbortController();
    await transport.prompt('do tools', {
      onChunk: (e) => events.push(e),
      signal: ac.signal,
    });

    const tools = events.filter((e): e is Extract<PromptStreamEvent, { kind: 'tool_progress' }> =>
      e.kind === 'tool_progress',
    );
    expect(tools).toEqual([
      { kind: 'tool_progress', name: 'read_file', state: 'start' },
      { kind: 'tool_progress', name: 'read_file', state: 'update' },
      { kind: 'tool_progress', name: 'read_file', state: 'end' },
    ]);

    await transport.close();
  }, 10000);

  it('boot timeout throws SessionBootstrapTimeoutError', async () => {
    await expect(
      HermesTransportImpl.open({
        command: fakeCommand(),
        env: { FAKE_HANG_INITIALIZE: '1' },
        bootTimeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(SessionBootstrapTimeoutError);
  }, 5000);
});
