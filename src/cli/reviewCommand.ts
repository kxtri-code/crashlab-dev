/**
 * The `review` command.
 *
 * Compares a current run against a known-good baseline and writes
 * `reports/candidates.json`.
 *
 * Opens no browser and makes no network call. It reads five local reports and
 * writes one, mutating none of them.
 *
 * The baseline and the reproduction report are both *optional*, and neither
 * being present is a valid review:
 *
 *  - no baseline        -> every signal is `unknown`, never `novel`
 *  - no reproduction    -> nothing is shown to have reproduced, so no signal
 *                          can be a candidate defect
 *
 * Absent evidence yields unknown, never a guess. That is the whole point of the
 * command being careful.
 *
 * Exits:
 *   0  candidate report written, whatever the verdicts
 *   1  an input was missing or invalid
 *   2  bad arguments
 */

import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { loadJourneyPlan } from '../executor/planValidator.js';
import { loadAnomalyInput, loadExecutionInput } from '../anomaly/validator.js';
import { readBaseline } from '../baseline/writer.js';
import { buildBaselineIdentity } from '../baseline/identity.js';
import { DEFAULT_BASELINE_DIR } from '../baseline/types.js';
import type { Baseline } from '../baseline/types.js';
import { findLatestCompatibleBaseline, loadBaselineAncestry, resolveBaselinePath } from '../baseline/registry.js';
import { buildCandidateReport, summarizeCandidateReport, writeCandidateReport } from '../review/candidateReport.js';
import { REPRODUCTION_SCHEMA_VERSION } from '../reproducer/types.js';
import type { ReproductionReport } from '../reproducer/types.js';
import { DEFAULT_CANDIDATE_OUTPUT_PATH } from '../review/types.js';
import type { CandidateBaselineDecision, CandidateSelectionMode } from '../review/types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Flags this command understands. */
export const REVIEW_FLAGS = [
  '--baseline',
  '--latest-compatible',
  '--baseline-dir',
  '--execution',
  '--anomalies',
  '--reproduction',
  '--no-reproduction',
  '--journey',
  '--output',
  '--out',
  '-o',
] as const;

/** Parsed `review` arguments. Pure, so it is unit-testable. */
export interface ParsedReviewArgs {
  baselinePath: string | null;
  latestCompatible: boolean;
  baselineDir: string;
  executionPath: string;
  anomaliesPath: string;
  reproductionPath: string | null;
  journeyPath: string;
  outputPath: string;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Parse `argv` for the `review` command. */
export function parseReviewArgs(argv: readonly string[]): ParsedReviewArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedReviewArgs = {
    baselinePath: null,
    latestCompatible: false,
    baselineDir: DEFAULT_BASELINE_DIR,
    executionPath: process.env.CRASHLAB_EXECUTION_INPUT?.trim() || 'reports/execution.json',
    anomaliesPath: process.env.CRASHLAB_ANOMALY_INPUT?.trim() || 'reports/anomalies.json',
    reproductionPath: process.env.CRASHLAB_REPRODUCTION_INPUT?.trim() || 'reports/reproduction.json',
    journeyPath: process.env.CRASHLAB_JOURNEY_INPUT?.trim() || 'reports/journey.json',
    outputPath: process.env.CRASHLAB_CANDIDATE_OUTPUT?.trim() || DEFAULT_CANDIDATE_OUTPUT_PATH,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(REVIEW_FLAGS as readonly string[]).includes(flag)),
  };

  if (parsed.unknown.length > 0) {
    parsed.error = `Unknown option: ${parsed.unknown[0]}. Run with --help to see the supported options.`;
    parsed.valid = false;
    return parsed;
  }

  const requireValue = (names: readonly string[]): string | null => {
    const found = flagValue(scan, names);
    if (!found.present) return null;
    if (found.missingValue) {
      parsed.error = `Option ${names[0]} requires a value.`;
      parsed.valid = false;
      return null;
    }
    return found.value;
  };

  const baseline = requireValue(['--baseline']);
  if (baseline !== null) parsed.baselinePath = baseline;
  parsed.latestCompatible = scan.flags.has('--latest-compatible');
  const baselineDir = requireValue(['--baseline-dir']);
  if (baselineDir !== null) parsed.baselineDir = baselineDir;
  const execution = requireValue(['--execution']);
  if (execution !== null) parsed.executionPath = execution;
  const anomalies = requireValue(['--anomalies']);
  if (anomalies !== null) parsed.anomaliesPath = anomalies;
  const journey = requireValue(['--journey']);
  if (journey !== null) parsed.journeyPath = journey;
  const output = requireValue(['--output', '--out', '-o']);
  if (output !== null) parsed.outputPath = output;

  // Build 7: mutual exclusivity between --baseline and --latest-compatible
  if (parsed.baselinePath !== null && parsed.latestCompatible) {
    parsed.error = 'Options --baseline and --latest-compatible are mutually exclusive. Specify one or neither.';
    parsed.valid = false;
    return parsed;
  }

  // Reading a reproduction report is optional, and opting out is a first-class
  // flag rather than a magic empty string, which shells mangle. An empty value
  // is accepted as the same intent, so both forms work.
  if (scan.flags.has('--no-reproduction')) {
    parsed.reproductionPath = null;
  } else {
    const reproduction = flagValue(scan, ['--reproduction']);
    if (reproduction.present) {
      if (reproduction.missingValue) {
        parsed.error = 'Option --reproduction requires a value.';
        parsed.valid = false;
      } else {
        parsed.reproductionPath = reproduction.value === '' ? null : reproduction.value;
      }
    }
  }

  return parsed;
}

/** Prefer a repo-relative path in terminal output. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

export const REVIEW_USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run review -- \\
    --baseline reports/baselines/<id>.json \\
    --execution reports/execution.json \\
    --anomalies reports/anomalies.json \\
    --reproduction reports/reproduction.json \\
    --journey reports/journey.json

Compares a current run against a known-good baseline and writes
reports/candidates.json.

Options:
  --baseline <path-or-id>  The known-good baseline to compare against (path or ID).
                           Optional: without one, everything is unknown.
  --latest-compatible      Build 7: select newest compatible baseline automatically.
                           Mutually exclusive with --baseline.
  --baseline-dir <path>    Storage directory for baselines [default: ${DEFAULT_BASELINE_DIR}]
  --execution <path>       Current execution report
  --anomalies <path>       Current anomaly report
  --reproduction <path>    Current reproduction report. Optional: without it,
                           nothing has been shown to reproduce. Use
                           --no-reproduction to skip reading one.
  --journey <path>         Current journey plan
  -o, --out <path>         Candidate report  [default: ${DEFAULT_CANDIDATE_OUTPUT_PATH}]

"No baseline means unknown, not novel." A signal is called novel only when it
reproduced AND a compatible baseline did not contain it.

Build 7 opens no browser, makes no network call, uses no AI, and confirms no bug.`;

export const REVIEW_SUMMARY_NOTE =
  'A novel signal is a lead for review, not a confirmed defect. Build 6 assigns no severity and proposes no fix.';

/** Read and structurally validate a reproduction report. */
async function readReproductionReport(path: string): Promise<ReproductionReport> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Reproduction report not found: ${path}. Use --no-reproduction to review without one.`,
      );
    }
    throw new Error(`Reproduction report could not be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Reproduction report is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Reproduction report root must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== REPRODUCTION_SCHEMA_VERSION) {
    throw new Error(`Unsupported reproduction report schemaVersion "${String(record['schemaVersion'])}".`);
  }
  if (!Array.isArray(record['results'])) {
    throw new Error('Reproduction report is missing a results array.');
  }
  return parsed as ReproductionReport;
}

/**
 * Run the `review` command.
 *
 * @returns the process exit code.
 */
export async function runReviewCommand(argv: readonly string[]): Promise<number> {
  const args = parseReviewArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    return 2;
  }

  let execution;
  let anomalies;
  let journey;
  try {
    [execution, anomalies, journey] = await Promise.all([
      loadExecutionInput(args.executionPath),
      loadAnomalyInput(args.anomaliesPath),
      loadJourneyPlan(args.journeyPath),
    ]);
  } catch (error) {
    console.error(`Cannot review: ${(error as Error).message}`);
    return 1;
  }

  // Build 7: select baseline according to selection mode
  let baseline: Baseline | null = null;
  let selectionMode: CandidateSelectionMode = 'none';
  let candidatesConsidered: CandidateBaselineDecision[] = [];
  let ancestorBaselines: Baseline[] = [];

  if (args.latestCompatible) {
    selectionMode = 'latest-compatible';
    const currentIdentity = buildBaselineIdentity(journey, execution);
    const latest = await findLatestCompatibleBaseline(currentIdentity, args.baselineDir);
    candidatesConsidered = latest.candidateDecisions;
    if (latest.selectedBaseline === null) {
      console.error(`Refusing to review: No compatible baseline found in ${args.baselineDir}.`);
      if (candidatesConsidered.length > 0) {
        console.error('Candidate baselines evaluated:');
        for (const c of candidatesConsidered) {
          console.error(`  - ${c.baselineId}: ${c.reason ?? 'incompatible'}`);
        }
      }
      return 1;
    }
    baseline = latest.selectedBaseline;
    ancestorBaselines = await loadBaselineAncestry(baseline, args.baselineDir);
  } else if (args.baselinePath !== null) {
    selectionMode = 'explicit';
    const resolvedPath = resolveBaselinePath(args.baselinePath, args.baselineDir);
    try {
      baseline = await readBaseline(resolvedPath);
      ancestorBaselines = await loadBaselineAncestry(baseline, args.baselineDir);
    } catch (error) {
      console.error(`Cannot review: ${(error as Error).message}`);
      return 1;
    }
  }

  // So is the reproduction report: nothing reproduced, nothing is a candidate.
  let reproduction = null;
  if (args.reproductionPath !== null) {
    try {
      reproduction = await readReproductionReport(args.reproductionPath);
    } catch (error) {
      console.error(`Cannot review: ${(error as Error).message}`);
      return 1;
    }
  }

  const report = buildCandidateReport({
    baseline,
    execution,
    anomalies,
    reproduction,
    journey,
    selectionMode,
    candidatesConsidered,
    ancestorBaselines,
    paths: {
      execution: args.executionPath,
      anomalies: args.anomaliesPath,
      reproduction: args.reproductionPath,
      journey: args.journeyPath,
      baseline: args.baselinePath ?? (baseline ? baseline.baselineId : null),
    },
  });

  const absolutePath = await writeCandidateReport(report, args.outputPath);

  console.log(summarizeCandidateReport(report));
  console.log(`  ${REVIEW_SUMMARY_NOTE}`);
  console.log(`Output: ${toDisplayPath(absolutePath)}`);

  return 0;
}
