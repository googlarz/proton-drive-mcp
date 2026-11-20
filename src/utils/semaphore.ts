/** FIFO counting semaphore. acquire() is abort-aware: an aborted waiter leaves the queue without ever holding a slot. */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    this.free = capacity;
  }

  /** Takes a slot only if one is free right now (never waits); returns its one-shot release function, or undefined when all are taken. */
  tryAcquire(): (() => void) | undefined {
    if (this.free <= 0) return undefined;
    this.free--;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next(); else this.free++;
    };
  }

  /** Resolves with a one-shot release function; rejects (without taking a slot) if `signal` aborts while queued. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    const release = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = this.waiters.shift();
        if (next) next(); else this.free++;
      };
    };
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(release());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(release());
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal!.reason instanceof Error ? signal!.reason : new Error("aborted"));
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
