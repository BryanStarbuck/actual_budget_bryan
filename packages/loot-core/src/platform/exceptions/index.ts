import { errorFileFor } from '@actual-app/error-file';

import { logger } from '#platform/server/log';

// pm/error_err.mdx §7 N6: every captureException call site now reports to the error file, with
// zero edits at those sites. The record is de-duplicated per Error object (R4).
const errors = errorFileFor('loot-core/src/platform/exceptions/index.ts');

export const captureException = function (exc: Error) {
  errors.caught('capturing an exception', exc);
};

export const captureBreadcrumb = function (crumb: unknown) {
  logger.info('[Breadcrumb]', crumb);
};
