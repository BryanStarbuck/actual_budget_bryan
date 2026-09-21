// NODE ONLY — the node sink and the process-level net (pm/error_err.mdx §3.1, §4.3, pattern 9).
//
// Used by the sync server, Electron main + utility process, @actual-app/api, the upstream `actual`
// CLI, and (as a vendored copy) `abx` and the MCP server.

import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  errorFileFor,
  flushErrorFile,
  hasErrorSink,
  readEnv,
  setErrorSink,
} from './core.ts';
import type { ErrorSink } from './core.ts';
import { formatRecord } from './format.ts';
import { RollingFileWriter } from './rolling-file-writer.ts';

export { RollingFileWriter } from './rolling-file-writer.ts';
export type { RollingFileWriterOptions } from './rolling-file-writer.ts';

export type NodeErrorFileOptions = {
  /** The runtime tag (§3.3): 'sync-server', 'electron-main', 'api', 'abx', … */
  app: string;
  /** Full path override. Default: ACTUAL_ERROR_FILE, else §3.1. */
  file?: string;
  /** The repo-relative path the process-level records report as. */
  where?: string;
  /** Install uncaughtException / unhandledRejection / exit / signal handlers. Default true. */
  handleProcessErrors?: boolean;
  /**
   * What an unhandled rejection does after it is written. true (default) keeps Node's own
   * behaviour — the process crashes, exactly as it would with no listener. false keeps the process
   * alive, for a host that already chose that (the sync server always has).
   */
  crashOnUnhandledRejection?: boolean;
  /** Echo records to stderr. Default: NODE_ENV development/test, or ACTUAL_ERROR_FILE_ECHO=1. */
  echo?: boolean;
  /** Only when no sink is installed yet (a library must not replace its host's). Default false. */
  onlyIfNoSink?: boolean;
};

export type NodeErrorFile = {
  /** Synchronous barrier: owed summaries and buffered lines are on disk when it returns. */
  flush: () => void;
  /** The file this process writes. */
  file: string;
};

function uid(): string {
  try {
    return String(userInfo().uid);
  } catch {
    return 'user';
  }
}

/** §3.1: ACTUAL_ERROR_FILE, else the test path (R13), else ~/T/actual_budget, else $TMPDIR. */
export function resolveErrorFilePath(
  env: Record<string, string | undefined>,
): string {
  const override = env.ACTUAL_ERROR_FILE;
  if (override) return override;
  if (env.VITEST || env.NODE_ENV === 'test') {
    return join(tmpdir(), `actual_budget_test_${uid()}`, 'error.err');
  }
  let home = '';
  try {
    home = homedir();
  } catch {
    home = '';
  }
  if (home) return join(home, 'T', 'actual_budget', 'error.err');
  return join(tmpdir(), `actual_budget_${uid()}`, 'error.err');
}

function defaultEcho(): boolean {
  if (readEnv('ACTUAL_ERROR_FILE_ECHO') === '1') return true;
  const mode = readEnv('NODE_ENV');
  return mode === 'development' || mode === 'test';
}

type Installed = {
  app: string;
  file: string;
  writer: RollingFileWriter;
  handlers: boolean;
};
let installed: Installed | null = null;

function installProcessHandlers(
  where: string,
  crashOnUnhandledRejection: boolean,
): void {
  const errors = errorFileFor(where);

  // uncaughtExceptionMonitor observes WITHOUT changing what happens next: Node's own crash (or the
  // host's uncaughtException handler) still runs. The FATAL record is on disk before it does (R9).
  process.on('uncaughtExceptionMonitor', err => {
    errors.fatal('an uncaught exception', err);
  });

  const onRejection = (reason: unknown): void => {
    const onlyUs = process.listenerCount('unhandledRejection') === 1;
    if (crashOnUnhandledRejection && onlyUs) {
      // Our listener replaced Node's default crash; restore it. The FATAL record is written and
      // flushed first; the monitor above then sees the same object and writes nothing (R4).
      errors.fatal('an unhandled promise rejection', reason);
      throw reason;
    }
    errors.caught('an unhandled promise rejection', reason);
  };
  process.on('unhandledRejection', onRejection);

  process.on('beforeExit', () => flushErrorFile());
  process.on('exit', () => flushErrorFile());

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const onSignal = (): void => {
      flushErrorFile();
      // Adding a listener removes Node's default "exit on signal". If ours is the only one,
      // re-raise so the process ends exactly as it would have without us.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

/**
 * Install the node sink for this process. Idempotent: a second call returns the first install.
 * Every path is total — a broken environment degrades to stderr, never to a throw.
 */
export function installNodeErrorFile(
  opts: NodeErrorFileOptions,
): NodeErrorFile {
  if (installed) {
    return { flush: flushErrorFile, file: installed.file };
  }
  if (opts.onlyIfNoSink && hasErrorSink()) {
    return { flush: flushErrorFile, file: '' };
  }
  const file = opts.file ?? resolveErrorFilePath(process.env);
  const writer = new RollingFileWriter({ filePath: file });
  const sink: ErrorSink = {
    app: opts.app,
    echo: opts.echo ?? defaultEcho(),
    verbose: readEnv('ACTUAL_ERROR_FILE_VERBOSE') === '1',
    write: record => writer.write(formatRecord(record)),
    flush: () => writer.flush(),
  };
  const handlers = opts.handleProcessErrors ?? true;
  installed = { app: opts.app, file, writer, handlers };
  setErrorSink(sink);
  if (handlers) {
    try {
      installProcessHandlers(
        opts.where ?? `${opts.app} (process)`,
        opts.crashOnUnhandledRejection ?? true,
      );
    } catch {
      // no usable process object; the sink still works
    }
  }
  return { flush: flushErrorFile, file };
}

/** Test seam: forget the install (does not remove process listeners). */
export function resetNodeErrorFileForTests(): void {
  installed = null;
  setErrorSink(null);
}
