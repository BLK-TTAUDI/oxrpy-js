/** Client-side token buckets, mirroring the API's own limits. */

export interface AcquireOptions {
  /** Give up (resolving `false`) after this many milliseconds. */
  timeoutMs?: number;
  /** `0` (default) for requests you make yourself, `1` for background polling, which waits behind them. */
  priority?: number;
  /** Give up (resolving `false`) when this aborts. */
  signal?: AbortSignal;
}

interface Waiter {
  resolve: (got: boolean) => void;
  done: boolean;
}

/** A first-in, first-out queue that stays fast with thousands of entries (no `Array.shift`). */
class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  peek(): T | undefined {
    return this.items[this.head];
  }

  shift(): T | undefined {
    const item = this.items[this.head];
    this.head += 1;
    // Drop the used front now and then, so the array doesn't grow forever.
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

/**
 * `rate` tokens a second, holding up to `capacity`. Waiting never blocks the event loop.
 *
 * Waiters are served in turn instead of racing for each token, so with many servers sharing one
 * limit nobody is starved. Priority `0` (requests you make yourself, like a Discord command's
 * lookup) goes ahead of priority `1` (background polling).
 */
export class TokenBucket {
  rate: number;
  capacity: number;
  private tokens: number;
  private updated: number;
  /** One queue per priority, best first. */
  private readonly queues = new Map<number, Fifo<Waiter>>();
  private priorities: number[] = [];
  private live = 0;
  private timer?: ReturnType<typeof setTimeout>;

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

  /** How many requests are queued for a token right now. */
  get waiting(): number {
    return this.live;
  }

  /** Change the steady rate (and the burst), e.g. when the API reports a different limit. */
  setRate(rate: number, capacity?: number): void {
    if (!(rate > 0)) throw new RangeError("rate must be positive");
    this.refill();
    this.rate = rate;
    if (capacity !== undefined) {
      this.capacity = Math.max(1, capacity);
      this.tokens = Math.min(this.tokens, this.capacity);
    }
  }

  /** Take a token if one is free right now and nobody's queued for it. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1 && this.live === 0) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Wait for a token, in turn. Resolves `false` if `timeoutMs` passes or `signal` aborts first.
   * (A number is taken as `timeoutMs`.)
   */
  acquire(options: AcquireOptions | number = {}): Promise<boolean> {
    const { timeoutMs, priority = 0, signal } = typeof options === "number" ? { timeoutMs: options } : options;
    if (signal?.aborted) return Promise.resolve(false);
    if (this.tryAcquire()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (got: boolean) => {
        if (waiter.done) return;
        waiter.done = true;
        this.live -= 1;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", giveUp);
        resolve(got);
      };
      const giveUp = () => finish(false);
      const waiter: Waiter = { resolve: finish, done: false };
      this.queue(priority).push(waiter);
      this.live += 1;
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) timeout = setTimeout(giveUp, Math.max(0, timeoutMs));
      signal?.addEventListener("abort", giveUp, { once: true });
      this.schedule();
    });
  }

  private queue(priority: number): Fifo<Waiter> {
    let queue = this.queues.get(priority);
    if (!queue) {
      queue = new Fifo<Waiter>();
      this.queues.set(priority, queue);
      this.priorities = [...this.queues.keys()].sort((a, b) => a - b);
    }
    return queue;
  }

  /** The next waiter still waiting: best priority first, then first come first served. */
  private next(): Fifo<Waiter> | undefined {
    for (const priority of this.priorities) {
      const queue = this.queues.get(priority)!;
      while (queue.length && queue.peek()!.done) queue.shift(); // gave up
      if (queue.length) return queue;
    }
    return undefined;
  }

  /** Hand out tokens to the waiters in turn. */
  private schedule(): void {
    if (this.timer) return;
    for (;;) {
      const queue = this.next();
      if (!queue) return;
      this.refill();
      if (this.tokens < 1) break;
      this.tokens -= 1;
      queue.shift()!.resolve(true);
    }
    const wait = ((1 - this.tokens) / this.rate) * 1000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.schedule();
    }, Math.max(1, wait));
  }

  /** Empty the bucket, e.g. after the API answered 429. */
  drain(): void {
    this.tokens = 0;
    this.updated = performance.now();
  }
}
