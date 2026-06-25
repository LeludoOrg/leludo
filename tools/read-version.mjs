// Shared parse of the VERSION constant in version.js. The Android version sync
// and the Play Store "what's new" extractor both need the same single source of
// truth — keep this the one place that reads it.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Read and parse `export const VERSION = "x"` from src/version.js.
 * Throws if the constant is missing so a malformed version.js fails loudly
 * rather than shipping an empty/undefined version.
 */
export async function readVersion(root = repoRoot) {
  const src = await readFile(resolve(root, 'src/version.js'), 'utf8');
  const match = src.match(/export\s+const\s+VERSION\s*=\s*["']([^"']+)["']/);
  if (!match) throw new Error('VERSION constant not found in version.js');
  return match[1];
}
