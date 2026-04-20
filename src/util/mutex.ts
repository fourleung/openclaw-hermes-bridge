type Waiter = { resolve: (release: () => void) => void; reject: (err: unknown) => void };

export class Mutex {
  private locked = false;
  private queue: Waiter[] = [];

  acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  rejectAll(err: unknown): void {
    const pending = this.queue.splice(0);
    for (const w of pending) {
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
        next.resolve(this.makeRelease());
      } else {
        this.locked = false;
      }
    };
  }
}
