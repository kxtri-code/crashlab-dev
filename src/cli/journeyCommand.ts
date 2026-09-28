/**
 * The `journey` command.
 *
 * Reads a natural-language goal and an existing Scout report, then writes a
 * deterministic journey plan. No browser is opened and no network call is made:
 * this command is a pure function of its two inputs.
 *
 * Exits:
 *   0  plan written
 *   1  the goal was empty, or the report was missing/unreadable/invalid
 *   2  bad arguments
 */

import { relative } from 'node:path';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { DEFAULT_SCOUT_OUTPUT_PATH } from '../report/write.js';
import { loadScoutReport, ScoutReportError } from '../journey/scoutLoader.js';
import { defaultJourneyPlanner } from '../journey/plan.js';
import type { JourneyPlanner } from '../journey/types.js';
import { DEFAULT_JOURNEY_OUTPUT_PATH, summarizeJourney, writeJourneyPlan } from '../journey/report.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Default Scout report path when `--scout` is omitted. */
export const DEFAULT_SCOUT_INPUT_PATH = DEFAULT_SCOUT_OUTPUT_PATH;

/** Parsed `journey` arguments. Pure, so it is unit-testable. */
export interface ParsedJourneyArgs {
  goal: string | null;
  scoutPath: string;
  outputPath: string;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Flags this command understands, for use in usage text and validation. */
export const JOURNEY_FLAGS = ['--goal', '--scout', '--out', '--output', '-o'] as const;

/**
 * Parse `argv` for the `journey` command.
 *
 * `scoutPath` is stored exactly as supplied - never resolved to an absolute
 * path - so that the plan records the same path on every machine and repeated
 * runs stay byte-identical.
 */
export function parseJourneyArgs(argv: readonly string[]): ParsedJourneyArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedJourneyArgs = {
    goal: null,
    scoutPath: DEFAULT_SCOUT_INPUT_PATH,
    outputPath: process.env.CRASHLAB_JOURNEY_OUTPUT?.trim() || DEFAULT_JOURNEY_OUTPUT_PATH,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(JOURNEY_FLAGS as readonly string[]).includes(flag)),
  };

  if (parsed.unknown.length > 0) {
    parsed.error = `Unknown option: ${parsed.unknown[0]}. Run with --help to see the supported options.`;
    parsed.valid = false;
    return parsed;
  }

  const goal = flagValue(scan, ['--goal']);
  if (goal.present) {
    if (goal.missingValue) {
      parsed.error = 'Option --goal requires a value.';
      parsed.valid = false;
      return parsed;
    }
    parsed.goal = goal.value;
  } else if (scan.positionals.length > 0) {
    // A positional goal is accepted so `journey "try to log in"` also works.
    parsed.goal = scan.positionals[0] ?? null;
  }

  const scout = flagValue(scan, ['--scout']);
  if (scout.present) {
    if (scout.missingValue) {
      parsed.error = 'Option --scout requires a path to a Scout report.';
      parsed.valid = false;
      return parsed;
    }
    parsed.scoutPath = scout.value ?? parsed.scoutPath;
  }

  const out = flagValue(scan, ['--out', '--output', '-o']);
  if (out.present) {
    if (out.missingValue) {
      parsed.error = 'Option --out requires a file path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.outputPath = out.value ?? parsed.outputPath;
  }

  return parsed;
}

/** Prefer a repo-relative path in terminal output; fall back to absolute. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

/**
 * Run the `journey` command.
 *
 * @param planner injectable for tests; defaults to the heuristic planner.
 * @returns the process exit code.
 */
export async function runJourneyCommand(argv: readonly string[], planner: JourneyPlanner = defaultJourneyPlanner): Promise<number> {
  const args = parseJourneyArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    return 2;
  }

  const goal = (args.goal ?? '').trim();
  if (!goal) {
    console.error('Missing goal. Usage:');
    console.error('  npm run journey -- --goal "Try to complete checkout" --scout reports/scout.json');
    return 1;
  }

  let report;
  try {
    report = await loadScoutReport(args.scoutPath);
  } catch (error) {
    if (error instanceof ScoutReportError) {
      console.error(`Cannot plan journey: ${error.message}`);
      return 1;
    }
    console.error(`Cannot plan journey: ${(error as Error).message}`);
    return 1;
  }

  // The plan records the path as the caller supplied it, for determinism.
  const plan = planner.plan({ goal, scout: report, scoutPath: args.scoutPath });

  const absolutePath = await writeJourneyPlan(plan, args.outputPath);

  console.log(summarizeJourney(plan));
  console.log(`Plan: ${toDisplayPath(absolutePath)}`);

  return 0;
}

/** Banner used by the dispatcher, shared with the `scout` command. */
export const JOURNEY_USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run journey -- --goal "<goal>" [--scout <path>] [--out <path>]
  npx tsx src/cli.ts journey --goal "<goal>" [--scout <path>] [--out <path>]

Options:
  --goal "<text>"    The user goal, in natural language (required)
  --scout <path>     Path to a Scout report [default: ${DEFAULT_SCOUT_INPUT_PATH}]
  -o, --out <path>   Journey plan output path   [default: ${DEFAULT_JOURNEY_OUTPUT_PATH}]

Build 2 plans only. It does not open a browser, click, type, submit, or call
any external service. Execution belongs to Build 3.`;
