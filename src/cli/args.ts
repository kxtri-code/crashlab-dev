/**
 * Shared command-line argument primitives.
 *
 * Extracted in Build 2 so the `scout` and `journey` commands parse flags the
 * same way, in both `--flag value` and `--flag=value` form, without either
 * command duplicating the other. Kept free of Build 1 specifics: this module
 * knows about token shapes, not about browsers or goals.
 */

/** Result of scanning a token list for flag *names* and their raw values. */
export interface FlagScan {
  /** `flag -> value` in first-seen order. A bare boolean flag maps to `null`. */
  readonly flags: ReadonlyMap<string, string | null>;
  /** Positional (non-flag) tokens, in order. */
  readonly positionals: readonly string[];
  /** The first token that could not be consumed, or `null` if none. */
  readonly error: string | null;
}

/** Split `--flag=value` into `[flag, value]`; `value` is `null` when absent. */
export function splitFlag(token: string): [string, string | null] {
  const eq = token.indexOf('=');
  if (eq < 0) return [token, null];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

/**
 * Split `argv` into flags and positionals.
 *
 * A flag's value is the next token, unless that token is itself a flag or is
 * missing. An inline `--flag=value` always wins. `--` ends flag parsing, so a
 * goal containing a leading dash can still be passed positionally.
 *
 * This performs no command-specific interpretation: which flags exist, which
 * need values, and what a positional means are all the caller's business.
 */
export function scanArgs(argv: readonly string[]): FlagScan {
  const flags = new Map<string, string | null>();
  const positionals: string[] = [];
  let error: string | null = null;
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (flagsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      flagsEnded = true;
      continue;
    }

    // A bare `-` and negative numbers are values, not flags.
    const looksLikeFlag = token.length > 1 && token.startsWith('-') && !/^-\d/.test(token);

    if (!looksLikeFlag) {
      positionals.push(token);
      continue;
    }

    const [flag, inlineValue] = splitFlag(token);
    if (inlineValue !== null) {
      flags.set(flag, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined) {
      // A trailing bare flag is recorded so the caller can reject it, since
      // only the caller knows which flags require a value.
      if (!flags.has(flag)) flags.set(flag, null);
      continue;
    }

    if (next.length > 1 && next.startsWith('-') && !/^-\d/.test(next)) {
      // The next token is another flag, so this one is a bare boolean.
      if (!flags.has(flag)) flags.set(flag, null);
      continue;
    }

    flags.set(flag, next);
    i += 1;
  }

  return { flags, positionals, error };
}

/**
 * Read a flag's value, falling back to a default and recording whether the
 * flag was present without a usable value.
 */
export function flagValue(
  scan: FlagScan,
  names: readonly string[],
): { present: boolean; value: string | null; missingValue: boolean } {
  for (const name of names) {
    if (!scan.flags.has(name)) continue;
    const value = scan.flags.get(name) ?? null;
    return { present: true, value, missingValue: value === null };
  }
  return { present: false, value: null, missingValue: false };
}
