export const FAKE_HERMES_SCRIPT = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
let cancelled = false;
let pendingPromptId = null;
let pendingChunks = [];
let sessionCounter = 0;
let promptCounter = 0;

function maybeFinishPrompt(stopReason) {
  if (pendingPromptId === null) return;
  send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason } });
  pendingPromptId = null;
}

function takePromptChunks() {
  const sequence = process.env.FAKE_PROMPT_SEQUENCE;
  if (sequence) {
    const parts = sequence.split(';');
    const idx = Math.min(promptCounter - 1, parts.length - 1);
    return [{ text: parts[idx] }];
  }

  const chunkSpec = process.env.FAKE_PROMPT_CHUNKS;
  return chunkSpec ? JSON.parse(chunkSpec) : [];
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
      const sid = msg.params.sessionId || (msg.params._meta && msg.params._meta.sessionId) || ('sess-' + process.pid + '-' + (++sessionCounter));
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid } });
    } else if (msg.method === 'session/prompt') {
      promptCounter += 1;
      pendingPromptId = msg.id;
      const sessionId = msg.params.sessionId;
      pendingChunks = takePromptChunks();
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

export function fakeHermesCommand(): string[] {
  return ['node', '-e', FAKE_HERMES_SCRIPT];
}
