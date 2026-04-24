# Contributing to openclaw-hermes-bridge

## Rules of engagement

1. **Public contract wins.** `README.md` and the current tests define the public
   behavior. If a change alters user-facing behavior, update both in the same
   commit.
2. **Keep the shape narrow.** This package is an OpenClaw-to-Hermes ACP bridge,
   not a generic agent orchestration framework. Avoid new abstraction layers or
   provider-management features unless the project scope changes explicitly.
3. **TDD.** Write the failing test, see it red, implement minimal code, see it
   green, commit. Don't skip red-before-green — a test that has never failed
   doesn't prove anything.

## Workflow

```
plan task ──► implementer ──► spec-compliance review ──► code-quality review ──► merge
                  │                    │                         │
                  └── writes test ─────┘                         │
                  └── minimal impl ────┘                         │
                  └── self-review ─────┘                         │
                                                                 │
                          fixes if issues found ◄────────────────┘
```

Two-stage review is mandatory for every non-trivial change:

1. **Spec compliance** — does the code match the task/spec as written? Any gaps
   or over-builds?
2. **Code quality** — tests, naming, file boundaries, hidden coupling. Reviews
   the diff, not pre-existing file size.

Skip neither stage.

## Commits

Conventional Commits, terse, present tense:

```
feat: add Mutex primitive
fix: drain queued delegates on lifetime evict
test: cover repair path with fresh per-attempt timer
docs: spell out 1s ack close protocol
chore: bump ajv to 8.18.0
refactor: extract per-attempt timer into helper
```

One commit per task in the normal flow. If a task has a follow-up fix from
review, use a second commit (`fix:` or `refactor:`) — **do not amend**. Amending
destroys the review trail.

## Code conventions

- **ESM only.** `package.json` has `"type": "module"`.
- **TypeScript imports inside `src/` and `test/` use the `.js` extension**, even
  though the source is `.ts`. This is the NodeNext ESM resolution rule. Do not
  "fix" these to `.ts`.
- **One file, one responsibility.** If a file grows past ~300 lines or mixes
  concerns, raise a concern before splitting on your own.
- **No overbuilding.** Don't add a helper because "someone might want it later".
  Stay inside the plan and spec.
- **No defensive validation at internal boundaries.** Trust internal types.
  Validate only at the public API boundary.
- **No backwards-compat shims.** The package is at `0.x`. Just change the code.
- **Comments are rare.** Only when the *why* is non-obvious (workaround, hidden
  invariant, surprising constraint). Don't narrate what well-named code already
  says. Don't reference task numbers or PR context in comments.

## Local commands

```bash
npm install
npm run typecheck
npm run lint
npm test                       # full suite
npm run test:watch             # vitest watch
npm run test:coverage          # enforces 85/80/85/85 thresholds
OPENCLAW_HERMES_BRIDGE_E2E=1 npm run test:e2e   # requires real hermes on PATH
npm run build                  # emits dist/
```

## What NOT to do

- ❌ Add an outer wall-clock timeout around `delegate()` (timeouts are per-attempt).
- ❌ Trigger repair on `timeout` or `agent_error` (only on `schema_error`).
- ❌ Reuse a **physical process instance** after timeout-kill (the logical `sessionId` is preserved, but `reused` must be `false` and `generation` incremented).
- ❌ Import Ajv as `from 'ajv'` (must be `from 'ajv/dist/2020'`).
- ❌ Cross-workflow session reuse, or close a session on the `final` event.
- ❌ Make `maxConcurrentSessions` saturation throw (it must block).
- ❌ Skip the 1 s ACP-cancel-ack wait in any close path.
- ❌ Add HTTP, WebSocket, or any registry-registration code path (B-only integration).

When in doubt, prefer the narrowest change that keeps README, tests, and package behavior aligned.
