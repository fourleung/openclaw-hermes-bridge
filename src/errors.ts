export class SessionEvictedError extends Error {
  constructor(public readonly reason: 'timeout-kill' | 'lifetime-drain') {
    super(`session evicted: ${reason}`);
    this.name = 'SessionEvictedError';
  }
}

export class HermesNotFoundError extends Error {
  constructor(public readonly command: string[]) {
    super(`hermes binary not found: ${command.join(' ')}`);
    this.name = 'HermesNotFoundError';
  }
}

export class BridgeShutdownError extends Error {
  constructor() {
    super('bridge is shut down');
    this.name = 'BridgeShutdownError';
  }
}

export class SessionBootstrapTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`session bootstrap timeout after ${timeoutMs}ms`);
    this.name = 'SessionBootstrapTimeoutError';
  }
}
