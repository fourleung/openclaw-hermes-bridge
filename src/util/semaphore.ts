type Waiter = {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
};

export class Semaphore {
  private permits: number;
  private readonly queue: Waiter[] = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1 || !Number.isInteger(capacity)) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${capacity}`);
    }
    this.permits = capacity;
  }

  available(): number {
    return this.permits;
  }

  acquire(signal?: globalThis.AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('aborted'));
    }

    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const onAbort = () => {
        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(signal!.reason ?? new Error('aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      this.queue.push(waiter);
    });
  }

  rejectAll(err: unknown): void {
    const pending = this.queue.splice(0);
    for (const w of pending) {
      w.cleanup?.();
      w.reject(err);
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      const next = this.queue.shift();
      if (next) {
        next.cleanup?.();
        next.resolve(this.makeRelease());
      } else {
        this.permits += 1;
      }
    };
  }
}
