import { describe, it, expect, vi } from 'vitest';
import { makeEmit } from '../src/emit.js';

describe('makeEmit', () => {
  it('fans out to logger.debug and onEvent with full fields', () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const onEvent = vi.fn();
    const emit = makeEmit({
      wfId: 'wf-1',
      attempt: 1,
      sessionId: 's-1',
      logger,
      onEvent,
    });

    emit({ type: 'status', phase: 'prompt_sent' });

    expect(onEvent).toHaveBeenCalledWith({
      type: 'status',
      phase: 'prompt_sent',
      workflowId: 'wf-1',
      sessionId: 's-1',
      attempt: 1,
    });
    expect(logger.debug).toHaveBeenCalled();
  });

  it('swallows synchronous onEvent exceptions and warns', () => {
    const logger = { warn: vi.fn() };
    const onEvent = vi.fn(() => {
      throw new Error('boom');
    });
    const emit = makeEmit({ wfId: 'x', attempt: 1, sessionId: null, logger, onEvent });
    expect(() => emit({ type: 'status', phase: 'session_open' })).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('detects thenable return and attaches .catch', async () => {
    const logger = { warn: vi.fn() };
    const onEvent = vi.fn(() => Promise.reject(new Error('async-err')) as unknown as void);
    const emit = makeEmit({ wfId: 'x', attempt: 1, sessionId: null, logger, onEvent });
    emit({ type: 'status', phase: 'session_open' });
    await new Promise((r) => globalThis.setTimeout(r, 10));
    const msgs = logger.warn.mock.calls.map((c) => c[1]);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringContaining('synchronous'),
    ]));
  });
});
