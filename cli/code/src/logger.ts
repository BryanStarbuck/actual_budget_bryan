/**
 * Logging — pm/cli.mdx §15.
 *
 * Two files under the state root the justfile already uses. Four rules:
 *
 *   - The machine key is never in either file. Only its fingerprint (R2).
 *   - NO FINANCIAL DATA. A count of rows, yes. A payee, an amount, an account
 *     number: no. A log file is the least-protected copy of anything it holds,
 *     and this one is about somebody's money.
 *   - Logging can never crash the CLI. Every filesystem fault here is
 *     swallowed — a tool that dies because it could not write a log line is a
 *     tool that dies for no reason.
 *   - Never /tmp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROTATE_BYTES = 8 * 1024 * 1024;
const GENERATIONS = 5;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ABX_STATE_DIR ?? path.join(os.homedir(), 'T', '_actual_budget');
}

export type Level = 'INFO' | 'WARN' | 'ERROR' | 'API_CALL';

/**
 * Rotate at 8MB, five generations. Best-effort: a rotation that fails is a
 * bigger log file, not a failed command.
 */
function rotateIfNeeded(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < ROTATE_BYTES) {
      return;
    }
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) {
        fs.renameSync(from, `${file}.${i + 1}`);
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Swallowed on purpose — see the module comment.
  }
}

export class Logger {
  #dir: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#dir = stateDir(env);
  }

  #append(name: 'cli.info' | 'cli.err', line: string): void {
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      const file = path.join(this.#dir, name);
      rotateIfNeeded(file);
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      // Swallowed on purpose — see the module comment.
    }
  }

  /**
   * INFO and API_CALL go to cli.info, FILE ONLY — never stdout, which belongs
   * to the answer (§13.1), and not stderr either, which belongs to the
   * operator.
   */
  info(level: Extract<Level, 'INFO' | 'API_CALL'>, message: string): void {
    this.#append(
      'cli.info',
      `[${new Date().toISOString()}] [${level}] ${message}`,
    );
  }

  /** WARN and ERROR go to cli.err. The caller decides separately about stderr. */
  error(level: Extract<Level, 'WARN' | 'ERROR'>, message: string): void {
    this.#append(
      'cli.err',
      `[${new Date().toISOString()}] [${level}] ${message}`,
    );
  }

  /**
   * One API_CALL line per machine-plane call.
   *
   * Deliberately absent: any argument value, any payee, any amount. The route
   * and a row count describe what happened without describing whose money it
   * happened to.
   */
  apiCall(opts: {
    verb: string;
    target: string;
    route: string;
    method: string;
    ms: number;
    outcome: 'ok' | 'error';
    rows?: number;
    keyFingerprint?: string;
  }): void {
    const parts = [
      `verb=${opts.verb}`,
      `target=${opts.target}`,
      `${opts.method} ${opts.route}`,
      `ms=${opts.ms}`,
      `outcome=${opts.outcome}`,
    ];
    if (opts.rows !== undefined) {
      parts.push(`rows=${opts.rows}`);
    }
    if (opts.keyFingerprint !== undefined) {
      parts.push(`key=${opts.keyFingerprint}`);
    }
    this.info('API_CALL', parts.join(' '));
  }
}
