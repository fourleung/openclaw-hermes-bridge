import type { BridgeEvent, Logger } from './types.js';

export interface EmitContext {
  wfId: string;
  attempt: number;
  sessionId: string | null;
  logger: Logger;
  onEvent?: (e: BridgeEvent) => unknown;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EmitInput = DistributiveOmit<BridgeEvent, 'workflowId' | 'attempt' | 'sessionId'>;

export function makeEmit(ctx: EmitContext): (evt: EmitInput) => void {
  return (evt: EmitInput) => {
    const full = {
      ...evt,
      workflowId: ctx.wfId,
      attempt: ctx.attempt,
      sessionId: ctx.sessionId,
    } as BridgeEvent;

    ctx.logger.debug?.({ component: 'openclaw_hermes_bridge', event: full }, 'bridge_event');

    if (!ctx.onEvent) {
      return;
    }

    try {
      const ret = ctx.onEvent(full);
      if (ret && typeof (ret as unknown as { then?: unknown }).then === 'function') {
        ctx.logger.warn?.({ component: 'openclaw_hermes_bridge' }, 'onEvent must be synchronous');
        (ret as unknown as Promise<unknown>).catch((err) => {
          ctx.logger.warn?.({ component: 'openclaw_hermes_bridge', err }, 'onEvent promise rejected');
        });
      }
    } catch (err) {
      ctx.logger.warn?.({ component: 'openclaw_hermes_bridge', err }, 'onEvent threw');
    }
  };
}
