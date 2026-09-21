import { errorFileFor } from '@actual-app/error-file';
import type { NextFunction, Request, Response } from 'express';
import * as expressWinston from 'express-winston';
import * as winston from 'winston';

import { validateSession } from './validate-user';

const errors = errorFileFor('sync-server/src/util/middlewares.ts');

/**
 * The route TEMPLATE of a request (`/sync/upload-user-file`, `/admin/users/:id`), never the raw URL:
 * no query string, no ids, no body (pm/error_err.mdx §11.4).
 */
function routeOf(req: Request): string {
  const template = req.route?.path;
  return (
    `${req.baseUrl ?? ''}${typeof template === 'string' ? template : ''}` ||
    '(no route)'
  );
}

async function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    // If you call next() with an error after you have started writing the response
    // (for example, if you encounter an error while streaming the response
    // to the client), the Express default error handler closes
    // the connection and fails the request.

    // So when you add a custom error handler, you must delegate
    // to the default Express error handler, when the headers
    // have already been sent to the client
    // Source: https://expressjs.com/en/guide/error-handling.html
    return next(err);
  }

  errors.caught(`handling ${req.method} ${routeOf(req)}`, err);
  res.status(500).send({ status: 'error', reason: 'internal-error' });
}

const validateSessionMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const session = await validateSession(req, res);
  if (!session) {
    return;
  }

  res.locals = session;
  next();
};

const requestLoggerMiddleware = expressWinston.logger({
  transports: [new winston.transports.Console()],
  format: winston.format.combine(
    ...(Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR')
      ? []
      : [winston.format.colorize()]),
    winston.format.timestamp(),
    winston.format.printf(args => {
      const { timestamp, level, meta } = args;
      const { res, req } = meta as { res: Response; req: Request };

      return `${String(timestamp)} ${String(level)}: ${req.method} ${res.statusCode} ${req.url}`;
    }),
  ),
});

export {
  validateSessionMiddleware,
  errorMiddleware,
  requestLoggerMiddleware,
  routeOf,
};
