import { startBackendWorker } from '@actual-app/core/platform/client/backend-worker';
import { send } from '@actual-app/core/platform/client/connection';
import type { InitConfig } from '@actual-app/core/server/main';
import { errorFileFor } from '@actual-app/error-file';

import InlineWorker from './browser-worker?worker&inline';

export * from './methods';
export * as utils from './utils';

const errors = errorFileFor('api/index.browser.ts');

let worker: Worker | null = null;

export async function init(
  config: InitConfig = {},
): Promise<{ send: typeof send }> {
  worker = new InlineWorker();

  try {
    await startBackendWorker(worker, config);
  } catch (error) {
    worker.terminate();
    worker = null;
    errors.rethrow('starting the backend worker', error);
  }

  return { send };
}

export async function shutdown() {
  if (worker) {
    try {
      await send('sync');
    } catch (e) {
      // most likely that no budget is loaded, so the sync failed
      errors.expected('syncing before shutdown', e);
    }
    try {
      await send('close-budget');
    } finally {
      worker.terminate();
      worker = null;
    }
  }
}
