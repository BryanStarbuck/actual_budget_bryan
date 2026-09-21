import fs, { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorFileFor } from '@actual-app/error-file';
import { createErrorReportHandler } from '@actual-app/error-file/ingest';
import { installNodeErrorFile } from '@actual-app/error-file/node';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { bootstrap } from './account-db';
import * as accountApp from './app-account';
import * as adminApp from './app-admin';
import * as akahuApp from './app-akahu/app-akahu.js';
import * as corsApp from './app-cors-proxy';
import * as enableBankingApp from './app-enablebanking/app-enablebanking';
import * as goCardlessApp from './app-gocardless/app-gocardless';
import * as openidApp from './app-openid';
import * as pluggai from './app-pluggyai/app-pluggyai';
import * as secretApp from './app-secrets';
import * as simpleFinApp from './app-simplefin/app-simplefin';
import * as syncApp from './app-sync';
import { config } from './load-config';
import {
  initMachinePlane,
  machineRouter,
  stopMachinePlane,
} from './machine/index.js';
import { errorMiddleware } from './util/middlewares';

const errors = errorFileFor('sync-server/src/app.ts');

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.set('trust proxy', config.get('trustedProxies'));
if (process.env.NODE_ENV !== 'development') {
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 500,
      legacyHeaders: false,
      standardHeaders: true,
    }),
  );
}

app.use(express.json({ limit: `${config.get('upload.fileSizeLimitMB')}mb` }));

app.use(
  express.raw({
    type: 'application/actual-sync',
    limit: `${config.get('upload.fileSizeSyncLimitMB')}mb`,
  }),
);

app.use(
  express.raw({
    type: 'application/encrypted-file',
    limit: `${config.get('upload.syncEncryptedFileSizeLimitMB')}mb`,
  }),
);

app.use('/sync', syncApp.handlers);
app.use('/account', accountApp.handlers);
app.use('/gocardless', goCardlessApp.handlers);
app.use('/simplefin', simpleFinApp.handlers);
app.use('/pluggyai', pluggai.handlers);
app.use('/akahu', akahuApp.handlers);
app.use('/enablebanking', enableBankingApp.handlers);
app.use('/secret', secretApp.handlers);

if (config.get('corsProxy.enabled')) {
  app.use('/cors-proxy', corsApp.handlers);
}

app.use('/admin', adminApp.handlers);
app.use('/openid', openidApp.handlers);

// The machine plane — pm/cli.mdx §5. Loopback-only, machine-key authenticated,
// the surface `abx` and the MCP speak.
//
// Mounted HERE, with the other route mounts, and NOT further down: the
// production branch below registers an SPA catch-all (`app.get('/{*splat}')`)
// and the dev branch proxies everything to Vite. Express matches in
// registration order, so a machine plane mounted after either one never runs —
// /machine/v1/ping returns index.html with a 200 and the CLI reports a
// successful response with no JSON body.
//
// It carries no key yet; initMachinePlane() arms it from run(), because
// resolving the key mints one and that must not happen merely because this
// module was imported. Until then it 404s (R9 — fail closed).
//
// It sets no Access-Control-Allow-Origin of its own and strips the one the
// app-wide cors() above added: it is not a browser surface, and §4.4a's origin
// gate refuses anything that looks like one.
app.use('/machine/v1', machineRouter);

// pm/error_err.mdx §8: browser and worker faults, loopback-only, always 204. Outside
// /machine/v1 (no key — a browser must never hold one) and BEFORE the SPA catch-all and the dev
// proxy below, which would otherwise swallow it.
app.post('/error-report', createErrorReportHandler({ via: 'sync-server' }));

app.get('/mode', (req, res) => {
  res.send(config.get('mode'));
});

app.get('/info', (_req, res) => {
  function findPackageJson(startDir: string) {
    // find the nearest package.json file while traversing up the directory tree
    let currentPath = startDir;
    let directoriesSearched = 0;
    const pathRoot = resolve(currentPath, '/');
    try {
      while (currentPath !== pathRoot && directoriesSearched < 5) {
        const packageJsonPath = resolve(currentPath, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(
            readFileSync(packageJsonPath, 'utf-8'),
          );

          if (packageJson.name === '@actual-app/sync-server') {
            return packageJson;
          }
        }

        currentPath = resolve(join(currentPath, '..')); // Move up one directory
        directoriesSearched++;
      }
    } catch (error) {
      errors.caught('searching for the sync-server package.json', error);
    }

    return null;
  }

  const dirname = resolve(fileURLToPath(import.meta.url), '../');
  const packageJson = findPackageJson(dirname);

  res.status(200).json({
    build: {
      name: packageJson?.name,
      description: packageJson?.description,
      version: packageJson?.version,
    },
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'UP' });
});

app.get('/metrics', (_req, res) => {
  res.status(200).json({
    mem: process.memoryUsage(),
    uptime: process.uptime(),
  });
});

// The web frontend.
// Dev mode proxies to Vite, which injects inline preamble scripts and uses
// a websocket for HMR. Loosen script-src and connect-src accordingly.
// `'unsafe-eval'` is required at runtime for the Electron app, so it is
// kept in both branches.
const isDev = process.env.NODE_ENV === 'development';
const scriptSrc = isDev
  ? "'self' 'unsafe-inline' 'unsafe-eval' blob:"
  : "'self' 'unsafe-eval' blob:";
const connectSrc = isDev ? "'self' ws: wss: http: https:" : 'http: https:';
const csp = [
  "default-src 'self' blob:",
  "img-src 'self' blob: data:",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
].join('; ');

app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  res.set('Content-Security-Policy', csp);
  next();
});
if (isDev) {
  console.log(
    'Running in development mode - Proxying frontend routes to React Dev Server',
  );

  // Imported within Dev block to allow dev dependency in package.json (reduces package size in production)
  const httpProxyMiddleware = await import('http-proxy-middleware');

  app.use(
    httpProxyMiddleware.createProxyMiddleware({
      target: 'http://localhost:3001',
      changeOrigin: true,
      ws: true,
    }),
  );
} else {
  console.log('Running in production mode - Serving static React app');

  app.use(express.static(config.get('webRoot'), { index: false }));
  app.get('/{*splat}', (req, res) =>
    res.sendFile('index.html', { root: config.get('webRoot') }),
  );
}

// pm/error_err.mdx §7 N9: an app-level error net, after every route. The sub-apps keep their own.
app.use(errorMiddleware);

function parseHTTPSConfig(value: string) {
  if (value.startsWith('-----BEGIN')) {
    return value;
  }
  return fs.readFileSync(value);
}

function sendServerStartedMessage() {
  // Signify to any parent process that the server has started. Used in electron desktop app
  // oxlint-disable-next-line typescript/ban-ts-comment
  // @ts-ignore-error electron types
  process.parentPort?.postMessage({ type: 'server-started' });
  console.log(
    'Listening on ' + config.get('hostname') + ':' + config.get('port') + '...',
  );
}

export async function run() {
  // pm/error_err.mdx §7 N9. Idempotent (the entry app.ts installs first). The sync server has always
  // stayed up on an unhandled rejection, so that is kept: it is written, not fatal.
  installNodeErrorFile({
    app: 'sync-server',
    where: 'sync-server/src/app.ts',
    crashOnUnhandledRejection: false,
  });
  const portVal = config.get('port');
  const port = typeof portVal === 'string' ? parseInt(portVal) : portVal;
  const hostname = config.get('hostname');
  const openIdConfig = config?.getProperties()?.openId;
  if (
    openIdConfig?.discoveryURL ||
    openIdConfig?.issuer?.authorization_endpoint
  ) {
    console.log('OpenID configuration found. Preparing server to use it');
    try {
      const result = await bootstrap({ openId: openIdConfig }, true);
      if (result && 'error' in result && result.error) {
        console.log(result.error);
      } else {
        console.log('OpenID configured!');
      }
    } catch (err) {
      errors.caught('bootstrapping OpenID at startup', err);
    }
  }

  // Arm the machine plane mounted above. This is what resolves — and, on a
  // first run, MINTS — the machine key, so it happens at boot rather than at
  // import: importing this module must never write a secret into the
  // developer's home directory as a side effect (pm/cli.mdx §4.3).
  const machinePlane = initMachinePlane();
  if (machinePlane) {
    console.log(
      `Machine plane armed on /machine/v1 ` +
        `(key ${machinePlane.keyFingerprint}, ${machinePlane.routeCount} routes, ` +
        `writes ${machinePlane.allowWrite ? 'ENABLED' : 'disabled'}, ` +
        `admin ${machinePlane.allowAdmin ? 'ENABLED' : 'disabled'})`,
    );

    // Close the budget's database on the way out. Without this, a restart can
    // find a lock held by a process that no longer exists (apis.mdx §15).
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void stopMachinePlane().finally(() => process.exit(0));
      });
    }
  }

  if (config.get('https.key') && config.get('https.cert')) {
    const https = await import('node:https');
    const httpsOptions = {
      ...config.get('https'),
      key: parseHTTPSConfig(config.get('https.key')),
      cert: parseHTTPSConfig(config.get('https.cert')),
    };
    https.createServer(httpsOptions, app).listen(port, hostname, () => {
      sendServerStartedMessage();
    });
  } else {
    app.listen(port, hostname, () => {
      sendServerStartedMessage();
    });
  }
}
