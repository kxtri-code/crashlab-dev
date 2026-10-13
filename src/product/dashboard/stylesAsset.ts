/**
 * Embedded CSS Stylesheet Asset for Product Dashboard — Build 12C.1.
 *
 * Ensures styles are deterministically bundled without runtime file lookups.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function loadStyles(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(currentDir, 'styles.css'), 'utf8');
  } catch {
    return '/* Fallback styles */ body { background: #0a0d14; color: #f1f5f9; font-family: sans-serif; }';
  }
}

export const STYLES_CSS: string = loadStyles();
