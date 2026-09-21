import { errorFileFor } from '@actual-app/error-file';

import { lib } from '#server/main';
import type { Handlers } from '#types/handlers';

import type * as T from './index-types';

const errors = errorFileFor(
  'loot-core/src/platform/client/connection/index.api.ts',
);

// In-process client for the api/node platform.
export const send = (async <K extends keyof Handlers>(
  name: K,
  args?: Parameters<Handlers[K]>[0],
  options?: { catchErrors?: boolean },
) => {
  if (options?.catchErrors) {
    try {
      return { data: await lib.send(name, args), error: undefined };
    } catch (error) {
      // The caller asked for the failure back as data; runHandler's net
      // (server/mutators.ts) has already reported any real fault.
      errors.expected(`returning the ${name} handler failure as data`, error);
      return { data: undefined, error };
    }
  }
  return lib.send(name, args);
}) as T.Send;
