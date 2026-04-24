import type { Envelope, DelegateOptions, Subtask, Logger } from './types.js';
import type { SessionManager, SessionHandle, SessionRecord } from './session-manager.js';
import { compileValidator, type ValidationError } from './validator.js';
import { extractJson, type ExtractionPath } from './json-extract.js';
import { buildInitialPrompt, buildRepairPrompt } from './prompt.js';
import { makeEmit } from './emit.js';
import { SessionEvictedError } from './errors.js';
import type { HermesTransport, PromptStreamEvent } from './transport/types.js';

export interface DelegateDeps {
  manager: SessionManager;
  workflowId: string;
  subtask: Subtask;
  opts: DelegateOptions;
  defaults: { defaultTimeoutMs: number };
  logger: Logger;
}

type EmitFn = ReturnType<typeof makeEmit>;

export async function delegate<T = unknown>(deps: DelegateDeps): Promise<Envelope<T>> {
  const startedAt = Date.now();
  const timeoutMs = deps.opts.timeoutMs ?? deps.defaults.defaultTimeoutMs;

  const acquisitionParts: globalThis.AbortSignal[] = [deps.manager.shutdownSignal];
  if (deps.opts.signal) acquisitionParts.push(deps.opts.signal);
  const acquisitionSignal =
    acquisitionParts.length === 1
      ? acquisitionParts[0]
      : globalThis.AbortSignal.any(acquisitionParts);

  const makeAttemptSignal = (): { signal: globalThis.AbortSignal; timeout: globalThis.AbortSignal } => {
    const timeout = globalThis.AbortSignal.timeout(timeoutMs);
    const parts: globalThis.AbortSignal[] = [timeout, deps.manager.shutdownSignal];
    if (deps.opts.signal) parts.push(deps.opts.signal);
    return { signal: globalThis.AbortSignal.any(parts), timeout };
  };

  let validator;
  try {
    validator = compileValidator<T>(deps.subtask.outputSchema);
  } catch (err) {
    return buildEnvelope<T>({
      status: 'agent_error',
      output: null,
      rawText: '',
      sessionId: null,
      attempt: 0,
      durationMs: Date.now() - startedAt,
      generation: 0,
      reused: false,
      error: { message: `invalid outputSchema: ${(err as Error).message}`, cause: err },
    });
  }

  let handle: SessionHandle | null = null;
  for (let retry = 0; ; retry += 1) {
    try {
      handle = await deps.manager.acquire(deps.workflowId, acquisitionSignal);
      break;
    } catch (err) {
      if (err instanceof SessionEvictedError && retry < 1) continue;
      return mapAcquireError<T>(err, startedAt);
    }
  }

  const sessionId = handle.session.transport.sessionId;
  const emitInitial = makeEmit({
    wfId: deps.workflowId,
    attempt: 1,
    sessionId,
    logger: deps.logger,
    onEvent: deps.opts.onEvent,
  });

  emitInitial({ type: 'status', phase: 'session_open' });

  let attempt = 1;
  let rawText = '';
  let lastErrors: ValidationError[] = [];
  let extractedValue: unknown = null;
  let currentTimeout: globalThis.AbortSignal | null = null;

  try {
    const att1 = makeAttemptSignal();
    currentTimeout = att1.timeout;
    const prompt1 = buildInitialPrompt(deps.subtask.prompt, deps.subtask.outputSchema);
    emitInitial({ type: 'status', phase: 'prompt_sent' });
    rawText = await runPrompt(handle.session.transport, prompt1, att1.signal, emitInitial);
    if (att1.signal.aborted) throw att1.signal.reason ?? new Error('aborted');
    deps.manager.refreshIdle(handle.session);

    const extracted1 = extractJson(rawText);
    if (!extracted1) {
      lastErrors = [{ path: '(root)', message: 'no JSON in response' }];
    } else {
      logExtractionPath(deps.logger, extracted1.path, rawText.length);
      const v1 = validator(extracted1.value);
      if (v1.valid) {
        return finalize<T>('ok', v1.value, rawText, sessionId, 1, startedAt, null, deps, handle);
      }
      lastErrors = v1.errors;
      extractedValue = extracted1.value;
    }

    attempt = 2;
    const emitRepair = makeEmit({
      wfId: deps.workflowId,
      attempt: 2,
      sessionId,
      logger: deps.logger,
      onEvent: deps.opts.onEvent,
    });
    deps.logger.warn?.({
      component: 'openclaw_hermes_bridge',
      ajv_errors: lastErrors,
      raw_text_length: rawText.length,
      extraction_path: extractedValue !== null ? 'some' : 'none',
    }, 'schema validation failed; repairing');
    emitRepair({ type: 'status', phase: 'repair_start' });

    const att2 = makeAttemptSignal();
    currentTimeout = att2.timeout;
    const prompt2 = buildRepairPrompt(lastErrors);
    emitRepair({ type: 'status', phase: 'prompt_sent' });
    rawText = await runPrompt(handle.session.transport, prompt2, att2.signal, emitRepair);
    if (att2.signal.aborted) throw att2.signal.reason ?? new Error('aborted');
    deps.manager.refreshIdle(handle.session);

    const extracted2 = extractJson(rawText);
    if (!extracted2) {
      return finalize<T>('schema_error', null, rawText, sessionId, 2, startedAt, {
        message: 'no JSON in repair response',
      }, deps, handle);
    }
    logExtractionPath(deps.logger, extracted2.path, rawText.length);
    const v2 = validator(extracted2.value);
    if (v2.valid) {
      return finalize<T>('ok', v2.value, rawText, sessionId, 2, startedAt, null, deps, handle);
    }
    return finalize<T>('schema_error', null, rawText, sessionId, 2, startedAt, {
      message: `response does not match schema: ${summarizeErrors(v2.errors)}`,
      cause: v2.errors,
    }, deps, handle);
  } catch (err) {
    return await mapPromptError<T>(err, rawText, sessionId, attempt, startedAt, deps, handle, currentTimeout);
  } finally {
    handle?.release();
  }
}

async function runPrompt(
  transport: HermesTransport,
  text: string,
  signal: globalThis.AbortSignal,
  emit: EmitFn,
): Promise<string> {
  const result = await transport.prompt(text, {
    signal,
    onChunk: (e: PromptStreamEvent) => {
      if (e.kind === 'message') emit({ type: 'message', text: e.text });
      else if (e.kind === 'tool_progress') emit({ type: 'tool_progress', name: e.name, state: e.state });
    },
  });
  return result.rawText;
}

function mapAcquireError<T>(err: unknown, startedAt: number): Envelope<T> {
  const msg = err instanceof Error ? err.message : String(err);
  const isAbort = err instanceof Error && (err.name === 'AbortError' || msg.includes('abort'));
  const isShutdown = err instanceof Error && err.name === 'BridgeShutdownError';
  return buildEnvelope<T>({
    status: isShutdown ? 'agent_error' : isAbort ? 'cancelled' : 'agent_error',
    output: null,
    rawText: '',
    sessionId: null,
    attempt: 0,
    durationMs: Date.now() - startedAt,
    generation: 0,
    reused: false,
    error: { message: msg, cause: err },
  });
}

async function mapPromptError<T>(
  err: unknown,
  rawText: string,
  sessionId: string,
  attempt: number,
  startedAt: number,
  deps: DelegateDeps,
  handle: SessionHandle | null,
  attemptTimeout: globalThis.AbortSignal | null,
): Promise<Envelope<T>> {
  const msg = err instanceof Error ? err.message : String(err);

  if (attemptTimeout?.aborted && handle) {
    await waitForAckOrDeadline(handle.session.transport, 1000, deps.logger).catch(() => { /* ignore */ });
    void deps.manager.evictTimeoutKill(handle.session).catch(() => { /* ignore */ });
    return finalize<T>('timeout', null, rawText, sessionId, attempt, startedAt, {
      message: `timeout after ${deps.opts.timeoutMs ?? deps.defaults.defaultTimeoutMs}ms`,
      cause: err,
    }, deps, handle);
  }

  if (deps.manager.shutdownSignal.aborted) {
    return finalize<T>('cancelled', null, rawText, sessionId, attempt, startedAt, {
      message: 'bridge shutting down',
      cause: err,
    }, deps, handle);
  }

  if (deps.opts.signal?.aborted) {
    return finalize<T>('cancelled', null, rawText, sessionId, attempt, startedAt, {
      message: 'aborted by caller',
      cause: err,
    }, deps, handle);
  }

  return finalize<T>('agent_error', null, rawText, sessionId, attempt, startedAt, {
    message: msg,
    cause: err,
  }, deps, handle);
}

async function waitForAckOrDeadline(
  transport: HermesTransport,
  deadlineMs: number,
  logger: Logger,
): Promise<void> {
  try {
    await transport.awaitCancelAck(deadlineMs);
  } catch (err) {
    logger.debug?.({ component: 'openclaw_hermes_bridge', err }, 'awaitCancelAck rejected');
  }
}

function finalize<T>(
  status: Envelope<T>['status'],
  output: T | null,
  rawText: string,
  sessionId: string | null,
  attempt: number,
  startedAt: number,
  error: Envelope<T>['error'],
  deps: DelegateDeps,
  handle: SessionHandle | null,
): Envelope<T> {
  const env = buildEnvelope<T>({
    status,
    output,
    rawText,
    sessionId,
    attempt,
    durationMs: Date.now() - startedAt,
    generation: handle?.session.generation ?? 0,
    reused: handle?.reused ?? false,
    error,
  });
  const emit = makeEmit({
    wfId: deps.workflowId,
    attempt,
    sessionId,
    logger: deps.logger,
    onEvent: deps.opts.onEvent,
  });
  if (status !== 'ok') {
    emit({ type: 'error', status: status as Exclude<Envelope<T>['status'], 'ok'>, message: error?.message ?? '' });
  }
  emit({ type: 'final', envelope: env as Envelope<unknown> });
  return env;
}

function buildEnvelope<T>(parts: {
  status: Envelope<T>['status'];
  output: T | null;
  rawText: string;
  sessionId: string | null;
  attempt: number;
  durationMs: number;
  generation: number;
  reused: boolean;
  error: Envelope<T>['error'];
}): Envelope<T> {
  return {
    status: parts.status,
    output: parts.output,
    rawText: parts.rawText,
    meta: { sessionId: parts.sessionId, attempt: parts.attempt, durationMs: parts.durationMs, generation: parts.generation, reused: parts.reused },
    error: parts.error,
  };
}

function summarizeErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.path} ${e.message}`).join('; ');
}

function logExtractionPath(logger: Logger, path: ExtractionPath, rawLen: number): void {
  if (path === 1) return;
  logger.warn?.({
    component: 'openclaw_hermes_bridge',
    extraction_path: path,
    raw_text_length: rawLen,
  }, `JSON extraction used fallback path ${path}`);
}
