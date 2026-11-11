/**
 * Append-only diagnostic journal for the Vertex adapter.
 *
 * A turn that goes silent leaves nothing to inspect afterwards, so the adapter
 * records a few one-line facts (model, sizes, phase timings, limiter state) in
 * `<DSH_HOME>/llm-vertex/debug.log`. The file is trimmed when it grows past
 * 256 KiB; logging never throws and never records credentials or prompt text.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 256 * 1024;

/**
 * Resolve the journal path without importing the settings service.
 *
 * @returns {string} absolute path to `debug.log`.
 */
export function journalPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'llm-vertex', 'debug.log');
}

/**
 * Append one line to the journal.
 *
 * @param {string} line - short, redacted description of a lifecycle event.
 * @returns {void}
 */
export function journal(line) {
  try {
    const file = journalPath();
    mkdirSync(join(file, '..'), { recursive: true });
    try {
      if (statSync(file).size > MAX_BYTES) writeFileSync(file, '');
    } catch {
      // Missing file on first write; nothing to trim.
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics must never break a turn.
  }
}
