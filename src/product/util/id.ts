/**
 * ID Generation Utility & Contract — Build 11: Hosted MVP Foundation.
 *
 * Enforces prefixed, collision-resistant, non-sequential durable IDs.
 * Supports dependency injection for deterministic testing.
 */

import { randomBytes, createHash } from 'node:crypto';

export type IdPrefix =
  | 'usr'
  | 'ws'
  | 'mem'
  | 'prj'
  | 'tgt'
  | 'jny'
  | 'run'
  | 'art'
  | 'candref'
  | 'aud';

export interface IdGenerator {
  generateId(prefix: IdPrefix): string;
}

export class DefaultIdGenerator implements IdGenerator {
  generateId(prefix: IdPrefix): string {
    const hex = randomBytes(8).toString('hex');
    return `${prefix}_${hex}`;
  }
}

/** Deterministic ID generator for reproducible unit testing. */
export class DeterministicIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly seed: string = 'test-seed') {}

  generateId(prefix: IdPrefix): string {
    this.counter += 1;
    const hash = createHash('sha256')
      .update(`${this.seed}:${prefix}:${this.counter}`)
      .digest('hex')
      .slice(0, 16);
    return `${prefix}_${hash}`;
  }

  reset(): void {
    this.counter = 0;
  }
}

export const defaultIdGenerator = new DefaultIdGenerator();
