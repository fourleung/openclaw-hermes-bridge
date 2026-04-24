# Changelog

All notable changes to `openclaw-hermes-bridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-24

### Added
- **Instance continuity observability** — added `reused` (boolean) and `session_generation` (number) fields to track the underlying process instance lifecycle independently of the logical `session_id`.
- `reused: true` indicates the delegation hit a running transport instance.
- `session_generation` increments whenever a specific `workflow_id` requires a fresh transport session (e.g., after idle timeout, crash, or explicit `close`).
- Documented session lifecycle fields in README (English and Chinese).
- Improved `subprocess` test reliability with stderr polling to avoid flakiness in buffered environments.

### Changed
- **Session ID Semantics** — `session_id` is now strictly a **logical会话 ID** (echo of `workflow_id`). Physical instance restarts no longer change the returned `sessionId`.
- Updated integration and E2E tests to align with logical session continuity.

### Fixed
- Transport `prompt()` short-circuits when the caller signal is already aborted at entry,
  preventing an indefinite hang when `shutdown()` races with an in-flight session boot.
  The ACP SDK's `connection.prompt()` does not reject on stream close, so callers
  relying on abort semantics would otherwise never resolve. (`d1272d1`)
- Default `sessionBootTimeoutMs` raised from 15 s to **60 s** based on empirical
  Hermes cold-start measurements (~35 s including ACP handshake). (`a151550`)
- Added L2 integration scenarios covering shutdown-in-flight and semaphore saturation. (`a8aecf1`)
- First end-to-end integration against real Hermes via an OpenClaw Workspace Extension.

## [0.1.0] — 2026-04-21

Initial release as 0.1.0 (previously tracked as 0.0.0 during scaffolding).

### Features
- **Public API** — `createBridge()` returns a `Bridge` with `delegate()`, `close()`,
  `shutdown()`.
- **Per-attempt timeout semantics** — each prompt attempt (initial and repair) gets a
  fresh `AbortSignal.timeout(timeoutMs)`, combined with caller signal and shutdown
  signal. No outer wall-clock envelope. Timeout does NOT cover semaphore wait or
  session boot.
- **Workflow-scoped session reuse** — same `workflowId` reuses the same agent session.
  No cross-workflow reuse.
- **Schema-validated structured output** — Ajv 2020 validator, JSON Schema 7 contract.
  One-shot repair attempt on `schema_error`; never on `timeout` or `agent_error`.
- **3-step JSON extraction ladder** — direct parse, fenced code block, best-effort
  substring match.
- **Session lifecycle** — idle TTL, max-lifetime drain, explicit `close(workflowId)`,
  timeout kill, global `shutdown()`. Max-lifetime drain evicts queued delegates via
  `SessionEvictedError`; public API retries automatically.
- **Unified close protocol** — ACP `cancel` → ≤1 s ack wait → close ACP session →
  SIGTERM → 2 s grace → SIGKILL. Applies to timeout kill, `close()`, and `shutdown()`.
- **Concurrency controls** — `max_concurrent_delegates_per_session = 1` (FIFO mutex).
  `maxConcurrentSessions` saturation blocks (does not error); wait is cancellable via
  caller `AbortSignal`.
- **Observability** — `BridgeEvent` side-channel emits status / message chunk /
  tool progress / final / error events for fan-out to logs or UI.
- **Transport** — ACP client over stdio JSON-RPC via `@agentclientprotocol/sdk`;
  stderr tail captured for diagnostics.

### Quality gates
- 69 / 69 tests pass (unit + L2 integration against fake Hermes + opt-in E2E against
  real Hermes).
- Coverage: 92.6 / 81.7 / 94.5 / 92.6 (stmts / branch / fn / line), above the
  85 / 80 / 85 / 85 thresholds.
- Strict TypeScript, ESLint clean, CI green.
