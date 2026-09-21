// Local copy of loot-core's `#shared/retry` helper. The Electron main process
// loads compiled JS at runtime and cannot import loot-core's TS source, so the
// (tiny) helper is duplicated here to avoid pulling in the `promise-retry`
// dependency.

import { errorFileFor } from './vendor/error-file/index.ts';

const errors = errorFileFor('desktop-electron/retry.ts');

type RetryCallback = (error?: unknown) => void;

type RetryOptions = {
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  factor?: number;
};

class RetrySignal {
  constructor(readonly error: unknown) {}
}

export function retry<T>(
  fn: (retry: RetryCallback, attempt: number) => Promise<T>,
  {
    retries = 10,
    minTimeout = 1000,
    maxTimeout = Infinity,
    factor = 2,
  }: RetryOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let attempt = 0;

    const onRetry: RetryCallback = error => {
      throw new RetrySignal(error);
    };

    const run = () => {
      attempt += 1;
      Promise.resolve()
        .then(() => fn(onRetry, attempt))
        .then(resolve, error => {
          if (!(error instanceof RetrySignal)) {
            // Handed to the caller, which reports it
            reject(error);
            return;
          }
          // The callback asked for another attempt: an answer, not a fault
          errors.expected('retrying after a failed attempt', error.error);
          if (attempt > retries) {
            reject(error.error);
            return;
          }
          const timeout = Math.min(
            minTimeout * factor ** (attempt - 1),
            maxTimeout,
          );
          setTimeout(run, timeout);
        });
    };

    run();
  });
}
