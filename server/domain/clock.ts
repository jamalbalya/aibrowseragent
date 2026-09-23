/**
 * Time, as an injected dependency.
 *
 * Every expiry, rotation and retirement decision reads this rather than
 * `Date.now()`, for two reasons. A test can put a session one millisecond
 * either side of its expiry and assert the boundary, which is where these
 * bugs live. And it keeps the rule visible that **server time decides**:
 * nothing in the domain reads a timestamp supplied by a client, because a
 * client clock is wrong when it is honest and arbitrary when it is not
 * (Cloud Sync SYNC-22).
 */
export interface Clock {
  /** Milliseconds since the epoch, from the server. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock a test drives by hand. */
export class FixedClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
