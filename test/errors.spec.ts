import { describe, it, expect } from 'vitest';
import {
  SessionEvictedError,
  HermesNotFoundError,
  BridgeShutdownError,
  SessionBootstrapTimeoutError,
} from '../src/errors.js';

describe('errors', () => {
  it('SessionEvictedError has correct name and message', () => {
    const e = new SessionEvictedError('timeout-kill');
    expect(e.name).toBe('SessionEvictedError');
    expect(e.message).toContain('timeout-kill');
    expect(e).toBeInstanceOf(Error);
  });

  it('HermesNotFoundError carries command', () => {
    const e = new HermesNotFoundError(['hermes', 'acp']);
    expect(e.name).toBe('HermesNotFoundError');
    expect(e.message).toContain('hermes acp');
  });

  it('BridgeShutdownError is distinct', () => {
    const e = new BridgeShutdownError();
    expect(e.name).toBe('BridgeShutdownError');
  });

  it('SessionBootstrapTimeoutError carries timeout ms', () => {
    const e = new SessionBootstrapTimeoutError(15000);
    expect(e.name).toBe('SessionBootstrapTimeoutError');
    expect(e.message).toContain('15000');
  });
});
