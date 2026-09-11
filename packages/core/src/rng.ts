/**
 * Seeded deterministic RNG. ADR-0007 bans `Math.random()` from the execution and evidence paths.
 * Every run records the seed it derived, so any run can be replayed exactly.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** Lowercase hex string of the requested length. */
  nextHex(length: number): string;
  /** Fisher-Yates over a copy. Does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * mulberry32: small, fast, well-distributed for our purposes, and — critically — trivially
 * reimplementable, so a recorded seed remains meaningful even if this file changes hands.
 */
export class SeededRng implements Rng {
  private state: number;

  constructor(seed: number) {
    // Force to uint32 so the sequence is identical across platforms.
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new Error("nextInt bounds must be integers");
    }
    if (maxExclusive <= minInclusive) {
      throw new Error("nextInt requires maxExclusive > minInclusive");
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }

  nextHex(length: number): string {
    let out = "";
    while (out.length < length) {
      out += Math.floor(this.next() * 0x100000000)
        .toString(16)
        .padStart(8, "0");
    }
    return out.slice(0, length);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i + 1);
      const a = copy[i] as T;
      const b = copy[j] as T;
      copy[i] = b;
      copy[j] = a;
    }
    return copy;
  }
}

/**
 * Derive a per-run seed from the base seed and the run coordinates.
 *
 * Two properties matter. First, it is a pure function, so the same coordinates always yield the
 * same seed and a run is replayable from its manifest alone. Second, adjacent coordinates yield
 * well-separated seeds, so repetition 3 and repetition 4 are not near-identical runs.
 */
export function deriveSeed(
  baseSeed: number,
  experimentId: string,
  repetitionIndex: number,
  attemptIndex: number
): number {
  let h = 0x811c9dc5 ^ (baseSeed >>> 0);
  const material = `${experimentId}|${repetitionIndex}|${attemptIndex}`;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // One mulberry32 step so neighbouring inputs diverge.
  h = (h + 0x6d2b79f5) >>> 0;
  let t = h;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}
