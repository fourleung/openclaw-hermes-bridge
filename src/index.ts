import { delegate } from './delegate-core.js';
import { SessionManager } from './session-manager.js';
import { transportFactory } from './transport/hermes-transport.js';
import type { TransportFactory } from './transport/types.js';
import { DEFAULTS, type Bridge, type CreateBridgeOptions, type DelegateOptions, type Envelope, type Subtask } from './types.js';

interface InternalOptions extends CreateBridgeOptions {
  __factory?: TransportFactory;
}

export function createBridge(rawOpts: CreateBridgeOptions = {}): Bridge {
  const opts = rawOpts as InternalOptions;
  const factory = opts.__factory ?? transportFactory;
  const logger = opts.logger ?? {};

  const manager = new SessionManager({
    factory,
    command: resolveCommand(opts.hermesCommand),
    env: opts.hermesEnv,
    cwd: opts.hermesCwd,
    maxConcurrentSessions: opts.maxConcurrentSessions ?? DEFAULTS.maxConcurrentSessions,
    idleTtlMs: opts.idleTtlMs ?? DEFAULTS.idleTtlMs,
    maxSessionLifetimeMs: opts.maxSessionLifetimeMs ?? DEFAULTS.maxSessionLifetimeMs,
    sessionBootTimeoutMs: opts.sessionBootTimeoutMs ?? DEFAULTS.sessionBootTimeoutMs,
    logger,
  });

  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs;
  let shutdown = false;

  return {
    async delegate<T = unknown>(
      workflowId: string,
      subtask: Subtask,
      delegateOpts: DelegateOptions = {},
    ): Promise<Envelope<T>> {
      if (shutdown) {
        return {
          status: 'agent_error',
          output: null,
          rawText: '',
          meta: { sessionId: null, attempt: 0, durationMs: 0 },
          error: { message: 'bridge is shut down' },
        };
      }

      return delegate<T>({
        manager,
        workflowId,
        subtask,
        opts: delegateOpts,
        defaults: { defaultTimeoutMs },
        logger,
      });
    },
    async close(workflowId: string): Promise<void> {
      await manager.close(workflowId);
    },
    async shutdown(): Promise<void> {
      if (shutdown) {
        return;
      }
      shutdown = true;
      await manager.shutdown();
    },
  };
}

function resolveCommand(optCommand?: string[]): string[] {
  if (optCommand && optCommand.length > 0) {
    return optCommand;
  }

  const envCmd =
    globalThis.process.env['OPENCLAW_HERMES_BRIDGE_HERMES_CMD']
    ?? globalThis.process.env['FLASH_BRIDGE_HERMES_CMD'];
  if (envCmd) {
    return envCmd.split(/\s+/).filter(Boolean);
  }

  return [...DEFAULTS.hermesCommand];
}

export type {
  Bridge,
  BridgeEvent,
  CreateBridgeOptions,
  DelegateOptions,
  Envelope,
  EnvelopeStatus,
  JSONSchema7,
  Logger,
  Subtask,
} from './types.js';
