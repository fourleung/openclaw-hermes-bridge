# openclaw-hermes-bridge

[中文说明](./README_zh-CN.md)

A Node.js [**ACP**](https://github.com/zed-industries/agent-client-protocol) (Agent Client Protocol) bridge for embedding Hermes delegation into OpenClaw workflows and plugins. Call `hermes acp` from host-process code via `bridge.delegate(workflowId, subtask)` and get a schema-validated, timeout-bounded `Envelope<T>`. No HTTP, no WebSocket, no registry — just stdio JSON-RPC with proper lifecycle management.

- **Workflow-scoped session pooling** — same `workflowId` reuses the same agent session; 6× speedup after cold start.
- **Per-attempt timeouts** — initial prompt and (if needed) repair prompt each get a fresh timer. No outer wall-clock envelope to blow up partway.
- **Schema-validated output** — JSON Schema 7 contract, Ajv 2020 under the hood, one-shot repair on `schema_error`.
- **Unified close protocol** — ACP `cancel` → ≤1 s ack wait → close session → SIGTERM → 2 s → SIGKILL. Same on timeout kill, explicit close, and shutdown.
- **Cancellable** — caller `AbortSignal` cancels at any stage (semaphore wait, session boot, prompt).
- **Observable** — `BridgeEvent` side-channel for chunks, tool progress, status transitions, final envelope.

Validated end-to-end against a production ACP agent via a host-process extension. Cold start is about 35 s on first boot; warm reuse is about 5 s in the same OpenClaw session.



## Install

macOS / Linux:

```bash
git clone https://github.com/fourleung/openclaw-hermes-bridge.git
cd openclaw-hermes-bridge
./setup.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/fourleung/openclaw-hermes-bridge.git
cd openclaw-hermes-bridge
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Requires Node ≥ 20.3. `hermes acp` must be installed and available on `PATH` (or pass `hermesCommand`).

If your PowerShell execution policy already allows local scripts, `.\setup.ps1` also works.

The package is currently distributed from source. The `npm install openclaw-hermes-bridge` and `npx openclaw-hermes-bridge ...` flows should be treated as future publish targets, not the current installation path.

`openclaw-hermes-bridge` is a library for Node.js code that runs inside an OpenClaw-hosted process. It is **not** an auto-registered OpenClaw plugin.

The install scripts above both build the package and scaffold the OpenClaw extension wiring for you.

This installs or updates a local OpenClaw extension under your home directory, typically:

- macOS / Linux: `~/.openclaw/workspace/.openclaw/extensions/hermes_bridge/`
- Windows: `%USERPROFILE%\.openclaw\workspace\.openclaw\extensions\hermes_bridge\`

When you run it from this repository checkout, it automatically points the generated extension back at your current local copy with a `file:` dependency. That avoids any npm publish requirement during local setup.

### Custom OpenClaw Workspace

macOS / Linux:

```bash
./setup.sh --workspace-root /path/to/openclaw/workspace
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 --workspace-root C:\path\to\openclaw\workspace
```

### Custom Package Reference

macOS / Linux:

```bash
./setup.sh --package-ref file:/absolute/path/to/openclaw-hermes-bridge
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 --package-ref file:C:\absolute\path\to\openclaw-hermes-bridge
```



## How Hermes Is Reached

This package does **not** connect to a fixed HTTP, WebSocket, or TCP address. It starts a local Hermes subprocess and speaks ACP over stdio.

Default behavior:

- Launch command: `hermes acp`
- Transport: stdio JSON-RPC
- Discovery: the `hermes` executable must be on `PATH`, unless you override it

You can override the default command in two ways:

- Pass `hermesCommand` to `createBridge()`
- Set `OPENCLAW_HERMES_BRIDGE_HERMES_CMD`

Example:

```ts
const bridge = createBridge({
  hermesCommand: ['/absolute/path/to/hermes', 'acp'],
});
```



## Library API (advanced)

```ts
import { createBridge } from './dist/index.js';
import type { JSONSchema7 } from 'json-schema';

const bridge = createBridge({
  // defaults shown
  hermesCommand: ['hermes', 'acp'],
  defaultTimeoutMs: 180_000,
  maxConcurrentSessions: 8,
});

const decomposeSchema: JSONSchema7 = {
  type: 'object',
  required: ['subtasks'],
  properties: {
    subtasks: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  additionalProperties: false,
};

const workflowId = 'run-2026-04-18-abc123';

const result = await bridge.delegate(workflowId, {
  prompt: 'Decompose this goal into 3-5 atomic subtasks: deploy to prod.',
  outputSchema: decomposeSchema,
}, {
  onEvent: (evt) => {
    if (evt.type === 'message') console.log('chunk:', evt.text);
  },
});

if (result.status === 'ok') {
  console.log(result.output.subtasks);
}

// Call close() when the workflow finishes; TTL is a safety net, not a replacement.
await bridge.close(workflowId);

// On process shutdown:
await bridge.shutdown();
```

This example is for repo-local library usage from this checkout after `npm run build`.

In normal OpenClaw usage, the generated extension created by `./setup.sh` or `.\setup.ps1` calls `createBridge()` for you, so most users do not need to write this code directly.

### Generated `call_hermes` tool semantics

The generated OpenClaw extension keeps **tracking** and **session reuse** separate:

- `task_id` — per-call tracking / audit ID
- `workflow_id` — Hermes context continuity key
- omitted `workflow_id` — falls back to the current OpenClaw `sessionKey`

That means repeated `call_hermes` calls in one OpenClaw session reuse the same Hermes session by default, while callers can still assign a unique `task_id` to every subtask.

## Architecture

Four layers, top-down dependency only:

```
                    ┌────────────────────────────┐
                    │  public API                │  ← src/index.ts
                    │  createBridge, Bridge      │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │  delegate-core             │  ← src/delegate-core.ts
                    │  prompt composition,       │
                    │  validation, repair,       │
                    │  per-attempt timer, emit   │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │  session-manager           │  ← src/session-manager.ts
                    │  workflow→session map,     │
                    │  mutex, semaphore,         │
                    │  idle TTL, lifetime,       │
                    │  eviction                  │
                    └──────────────┬─────────────┘
                                   │
                    ┌──────────────▼─────────────┐
                    │  transport                 │  ← src/transport/
                    │  ACP client wrap +         │
                    │  subprocess spawn          │
                    └────────────────────────────┘
```

This repository keeps the public API and architecture intentionally narrow: public API -> delegate core -> session manager -> transport. If you change behavior, update this README and the tests in the same change.



## Configuration

| Option | Default | Purpose |
|---|---|---|
| `hermesCommand` | `['hermes', 'acp']` | Override binary + args |
| `hermesEnv` | `{}` | Merged with `process.env` |
| `hermesCwd` | `undefined` | Subprocess working directory |
| `logger` | no-op | pino-compatible structured logger |
| `defaultTimeoutMs` | `180000` | **Per-attempt** wall-clock (initial prompt and repair prompt each get their own fresh timer; does not cover semaphore wait or session boot) |
| `idleTtlMs` | `600000` | Close session after this much idle time |
| `maxSessionLifetimeMs` | `3600000` | Drain session after this much elapsed time |
| `maxConcurrentSessions` | `8` | Global session cap; over-limit calls block |
| `sessionBootTimeoutMs` | `60000` | Spawn + ACP `initialize` + `newSession`. Sized for a typical ACP agent's cold start (~35 s observed in reference deployments) with margin |

Environment variable: `OPENCLAW_HERMES_BRIDGE_HERMES_CMD` (space-separated) overrides the default command when `hermesCommand` is not set. The legacy `FLASH_BRIDGE_HERMES_CMD` alias is still accepted for local compatibility.

This package only supports a local stdio subprocess transport in the current release. It does not support HTTP, WebSocket, or TCP-based Hermes endpoints.



## Return Values

`delegate()` returns an envelope instead of throwing for normal runtime outcomes.

Key statuses:

- `ok` — output matched the schema
- `schema_error` — initial and repair attempts both failed schema validation
- `agent_error` — transport or agent failure
- `timeout` — the per-attempt timer fired and the session was not reused
- `cancelled` — caller abort or bridge shutdown

`meta.attempt` is `1` on the happy path and `2` when the repair path was used.



## Events

Pass `onEvent` to observe progress while `delegate()` runs:

```ts
await bridge.delegate(workflowId, subtask, {
  onEvent: (evt) => {
    if (evt.type === 'message') {
      console.log(evt.text);
    }

    if (evt.type === 'status') {
      console.log('phase:', evt.phase);
    }
  },
});
```

Useful event types are:

- `status` — lifecycle transitions such as `session_open`, `prompt_sent`, `repair_start`
- `message` — streamed text chunks from Hermes
- `tool_progress` — tool call progress updates
- `final` — emitted right before the final envelope is returned
- `error` — terminal non-`ok` outcome

Events are fire-and-forget. The returned envelope remains the authoritative result.



## Troubleshooting

**Cold start takes > 60 s.** `sessionBootTimeoutMs` rejects with `SessionBootstrapTimeoutError`. Check that your agent's ACP binary runs standalone in reasonable time; the cost is subprocess spawn + ACP `initialize` + `newSession`. If real cold-start latency is higher than 60 s on your host, raise `sessionBootTimeoutMs` — this is a separate timer from `defaultTimeoutMs`.

**Repeated `schema_error`.** Repair runs once and only on schema failure. If both attempts fail, the likely causes are (a) prompt is ambiguous about the required shape, (b) `outputSchema` is stricter than what the agent can produce, or (c) agent is emitting prose around the JSON that the 3-step extraction ladder can't recover. Make the prompt spell out the schema verbatim.

**`timeout` envelope with a partial `rawText`.** Expected. When the per-attempt timer fires, an ACP `cancel` is sent and the bridge waits ≤1 s for ack before killing the subprocess. Whatever chunks arrived before the timer are preserved in `rawText`. The session is **not** reused; the next `delegate()` on the same `workflowId` boots a fresh one. There is **no auto-retry**.

**`cancelled` during `bridge.shutdown()` race.** If you call `shutdown()` while a `delegate()` is in flight, the in-flight call returns `status: 'cancelled'` with `error.message` mentioning shutdown. The unified close protocol runs in full (cancel → 1 s ack → close → SIGTERM → 2 s → SIGKILL) so no stray subprocesses leak.

**Saturation at `maxConcurrentSessions`.** Calls block in a FIFO semaphore. They do **not** error. Pass an `AbortSignal` in `DelegateOptions.signal` if you need cancellation while waiting for capacity.



## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run test:coverage           # enforces 85/80/85/85 thresholds
OPENCLAW_HERMES_BRIDGE_E2E=1 npm run test:e2e   # requires real hermes on PATH
```

Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md). Changelog: [`CHANGELOG.md`](CHANGELOG.md).



## License

MIT
