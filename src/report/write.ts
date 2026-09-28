/**
 * Report persistence. The only module in Build 1 that writes to disk.
 *
 * Generic over the report shape since Build 2 (journey plans) reuses it, so the
 * output convention stays in one place.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Default Scout report path. */
export const DEFAULT_SCOUT_OUTPUT_PATH = 'reports/scout.json';

/**
 * Default report path, kept under the Build 1 name for compatibility with the
 * existing `scout` command and its tests.
 */
export const DEFAULT_OUTPUT_PATH = DEFAULT_SCOUT_OUTPUT_PATH;

/** Resolve the output path against the current working directory. */
export function resolveOutputPath(outputPath: string = DEFAULT_OUTPUT_PATH, cwd: string = process.cwd()): string {
  return resolve(cwd, outputPath);
}

/**
 * Write a report as pretty-printed JSON, creating parent directories as needed.
 * Returns the absolute path written.
 */
export async function writeReport<T extends object>(
  report: T,
  outputPath: string = DEFAULT_OUTPUT_PATH,
  cwd: string = process.cwd(),
): Promise<string> {
  const absolutePath = resolveOutputPath(outputPath, cwd);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return absolutePath;
}
