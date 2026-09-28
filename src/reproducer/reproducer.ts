/**
 * Reproducer orchestration.
 *
 * Validates, selects eligible signals, runs a bounded number of controlled
 * attempts, and compares. The order matters and is deliberate:
 *
 *  1. everything is validated first,
 *  2. authorization is required,
 *  3. eligibility is evaluated,
 *  4. *only then* is a browser opened - and only if there is something to run.
 *
 * A run with no eligible signals therefore never launches a browser at all,
 * which is both faster and safer.
 *
 * Nothing here mutates its inputs. The journey, the anomaly report and the
 * original execution report are read and left byte-identical.
 */

import { partitionEligible } from './eligibility.js';
import { runAttempt } from './attemptRunner.js';
import { buildReproductionReport } from './reproductionReport.js';
import type { ReproductionInput, ReproductionReport, ReproductionRun } from './types.js';
import { ReproductionInputError } from './types.js';

/** Raised when a run is refused before any browser opens. */
export class ReproductionRefused extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ReproductionRefused';
    this.reason = reason;
  }
}

/**
 * Run the controlled reproducer.
 *
 * @param input validated inputs and configuration.
 * @returns the reproduction report.
 */
export async function reproduceSignals(input: ReproductionInput): Promise<ReproductionReport> {
  // --- gate 1: authorization -------------------------------------------
  if (!input.authorized) {
    throw new ReproductionRefused(
      'not-authorized',
      'Reproduction was refused: --confirm-authorized was not supplied, so no browser was opened.',
    );
  }

  // --- gate 2: eligibility, before any browser -------------------------
  const { eligible } = partitionEligible(input.anomalies.anomalies, input.includePossiblyExpected);

  if (eligible.length === 0) {
    // Nothing worth rerunning. A report is still produced - it accounts for
    // every signal and explains why each was excluded - but no browser runs.
    return buildReproductionReport(input, []);
  }

  // --- gate 3: bounded attempts ----------------------------------------
  const attempts: ReproductionRun[] = [];
  for (let attempt = 1; attempt <= input.attempts; attempt++) {
    attempts.push(await runAttempt(input, attempt));
  }

  return buildReproductionReport(input, attempts);
}

/** Convenience: validate the attempt count before building the input. */
export function assertAttemptsValid(attempts: number): void {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new ReproductionInputError('attempts', `Attempt count must be a whole number between 1 and 5, got ${attempts}.`);
  }
}
