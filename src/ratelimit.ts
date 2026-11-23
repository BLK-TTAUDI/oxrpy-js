/** Client-side token buckets, mirroring the API's own limits. */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `rate` tokens a second, holding up to `capacity`. Waiting never blocks the event loop. */
export class TokenBucket {
  readonly rate: number;
  readonly capacity: number;
  private tokens: number;
  private updated: number;

  constructor(rate: number, capacity: number) {
    if (!(rate > 0)) throw new RangeError("rate must be positive");
    this.rate = rate;
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.updated = performance.now();
  }

  private refill(): void {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 1000) * this.rate);
    this.updated = now;
  }

  /** Take a token if one is free right now. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Wait for a token. Resolves `false` if `timeoutMs` passes first. */
  async acquire(timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
    for (;;) {
      // No await between the check and the take, so concurrent callers can't both take it.
      if (this.tryAcquire()) return true;
      let wait = ((1 - this.tokens) / this.rate) * 1000;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      wait = Math.min(wait, remaining);
      await sleep(Math.max(1, wait));
    }
  }

  /** Empty the bucket, e.g. after the API answered 429. */
  drain(): void {
    this.tokens = 0;
    this.updated = performance.now();
  }
}
