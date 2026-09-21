import { errorFileFor } from '@actual-app/error-file';

const errors = errorFileFor('loot-core/src/shared/async.ts');

// oxlint-disable-next-line typescript/no-explicit-any
type AnyFunction = (...args: any[]) => any;

export function sequential<T extends AnyFunction>(
  fn: T,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  const sequenceState: {
    running: Promise<Awaited<ReturnType<T>>> | null;
    queue: Array<{
      args: Parameters<T>;
      resolve: (
        value: Awaited<ReturnType<T>> | PromiseLike<Awaited<ReturnType<T>>>,
      ) => void;
      reject: (reason?: unknown) => void;
    }>;
  } = {
    running: null,
    queue: [],
  };

  function pump() {
    const next = sequenceState.queue.shift();
    if (next !== undefined) {
      run(next.args, next.resolve, next.reject);
    } else {
      sequenceState.running = null;
    }
  }

  function run(
    args: Parameters<T>,
    resolve: (
      value: Awaited<ReturnType<T>> | PromiseLike<Awaited<ReturnType<T>>>,
    ) => void,
    reject: (reason?: unknown) => void,
  ) {
    sequenceState.running = fn.apply(null, args).then(
      (val: Awaited<ReturnType<T>> | PromiseLike<Awaited<ReturnType<T>>>) => {
        pump();
        resolve(val);
      },
      (err: unknown) => {
        // The rejection is forwarded to the caller's promise, which reports it.
        errors.expected('forwarding a rejection from a sequenced call', err);
        pump();
        reject(err);
      },
    );
  }

  return ((...args: Parameters<T>) => {
    if (!sequenceState.running) {
      return new Promise<Awaited<ReturnType<T>>>((resolve, reject) => {
        return run(args, resolve, reject);
      });
    } else {
      return new Promise<Awaited<ReturnType<T>>>((resolve, reject) => {
        sequenceState.queue.push({ resolve, reject, args });
      });
    }
  }) as T;
}

export function once<T extends AnyFunction>(
  fn: T,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> | null {
  let promise: Promise<Awaited<ReturnType<T>>> | null = null;
  return (...args: Parameters<T>) => {
    if (!promise) {
      promise = fn.apply(null, args).finally(() => {
        promise = null;
      });
      return promise;
    }

    return promise;
  };
}
