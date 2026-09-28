/**
 * Goal normalisation.
 *
 * Pure and deterministic. Normalisation is what makes matching case- and
 * whitespace-insensitive without every matcher having to re-think it.
 */

/** Collapse whitespace, trim, and lower-case. Empty input normalises to `''`. */
export function normalizeGoal(goal: string | null | undefined): string {
  if (goal === null || goal === undefined) return '';
  return String(goal)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Reduce a goal to a bag of tokens.
 *
 * Keeps alphanumerics and collapses everything else to single spaces, so
 * `Checkout / Pay`, `checkout---pay` and `  CHECKOUT   pay ` all tokenise the
 * same way.
 */
export function tokenize(normalizedGoal: string): string[] {
  if (!normalizedGoal) return [];
  return normalizedGoal
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
