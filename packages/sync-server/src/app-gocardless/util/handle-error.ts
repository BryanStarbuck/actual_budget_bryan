import { errorFileFor } from '@actual-app/error-file';
import type { Request, Response } from 'express';

const errors = errorFileFor(
  'sync-server/src/app-gocardless/util/handle-error.ts',
);

/**
 * The route TEMPLATE of a request (`/gocardless/transactions`), never the raw
 * URL: no query string, no ids, no body (pm/error_err.mdx §11.4). Kept local
 * rather than imported from `#util/middlewares`, which tests mock wholesale.
 */
function routeOf(req: Request): string {
  const template = req.route?.path;
  return (
    `${req.baseUrl ?? ''}${typeof template === 'string' ? template : ''}` ||
    '(no route)'
  );
}

export function handleError(
  func: (req: Request, res: Response) => Promise<unknown>,
) {
  return (req: Request, res: Response) => {
    func(req, res).catch(err => {
      errors.caught(`handling ${req.method} ${routeOf(req)}`, err);
      res.send({
        status: 'ok',
        data: {
          error_code: 'INTERNAL_ERROR',
          error_type: err.message ? err.message : 'internal-error',
        },
      });
    });
  };
}
