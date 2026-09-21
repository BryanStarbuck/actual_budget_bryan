import { init as initLootCore } from '@actual-app/core/server/main';
import type { InitConfig, lib } from '@actual-app/core/server/main';
import { errorFileFor } from '@actual-app/error-file';
import { installNodeErrorFile } from '@actual-app/error-file/node';

import { validateNodeVersion } from './validateNodeVersion';

export * from './methods';
export * as utils from './utils';

const errors = errorFileFor('api/index.ts');

/** @deprecated Please use return value of `init` instead */
export let internal: typeof lib | null = null;

export async function init(config: InitConfig = {}) {
  validateNodeVersion();

  // pm/error_err.mdx §7 N16: the api is a library inside somebody else's process. It installs the
  // node sink only when the host has none, and it never touches the host's process handlers.
  installNodeErrorFile({
    app: 'api',
    where: 'api/index.ts',
    handleProcessErrors: false,
    onlyIfNoSink: true,
  });

  internal = await initLootCore(config);
  return internal;
}

export async function shutdown() {
  if (internal) {
    try {
      await internal.send('sync');
    } catch (err) {
      // most likely that no budget is loaded, so the sync failed
      errors.expected('syncing before shutdown', err);
    }

    await internal.send('close-budget');
    internal = null;
  }
}
