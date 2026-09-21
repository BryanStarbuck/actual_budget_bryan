import { runClassic } from 'eslint-vitest-rule-tester';

import plugin from '../../index';
const rule = plugin.rules['catch-must-report'];

const filename = 'packages/loot-core/src/server/budgetfiles/app.ts';

void runClassic(
  'catch-must-report',
  rule,
  {
    valid: [
      // Pattern 1 — plain try/catch that reports and continues
      {
        code: `async function f() { try { await upload(); } catch (e) { errors.caught('uploading the budget file', e); return { error: 1 }; } }`,
        filename,
      },
      // Pattern 2 — cleanup then rethrow through the library
      {
        code: `try { db.transaction(fn); } catch (e) { db.execQuery('ROLLBACK'); errors.rethrow('running a database transaction', e); }`,
        filename,
      },
      // Pattern 2 — a bare rethrow is a hand-off to the frame that reports
      {
        code: `try { run(); } catch (e) { cleanup(); throw e; }`,
        filename,
      },
      // Pattern 3 — the expected failure
      {
        code: `let cfg; try { cfg = JSON.parse(read()); } catch (e) { errors.expected('reading the optional config.json', e); cfg = {}; }`,
        filename,
      },
      // Pattern 3 — split expected / caught
      {
        code: `try { x(); } catch (e) { if (isEnoent(e)) errors.expected('reading it', e); else errors.caught('reading it', e); }`,
        filename,
      },
      // Pattern 4 — tryOr / tryOrAsync are not catch sites at all
      {
        code: `const parsed = tryOr(errors, 'parsing the widget settings', () => JSON.parse(meta), null);
const rates = await tryOrAsync(errors, 'fetching exchange rates', () => fetchRates(day), []);`,
        filename,
      },
      // Pattern 5 — a .catch() that recovers and reports inside
      {
        code: `const files = await listFiles().catch(e => { errors.caught('listing budget files', e); return []; });`,
        filename,
      },
      // Pattern 5 — .catch() that hands the rejection on
      {
        code: `p.catch(e => Promise.reject(e)); q.catch(e => { return Promise.reject(e); });`,
        filename,
      },
      // Pattern 6 — guard wraps a listener; the error listener itself reports
      {
        code: `input.addEventListener('change', guard(errors, 'importing the chosen file', async e => { await importFile(e); }));
window.addEventListener('error', ev => { errors.caught('handling a window error', ev.error); });`,
        filename,
      },
      // Pattern 7 — ErrorBoundary onError from the library
      {
        code: `const x = <ErrorBoundary FallbackComponent={Fallback} onError={reportBoundaryError(errors, 'rendering the app shell')}><App /></ErrorBoundary>;`,
        filename: 'packages/desktop-client/src/components/App.tsx',
      },
      // Pattern 7 — showBoundary hands off to the boundary's onError
      {
        code: `try { render(); } catch (e) { showBoundary(e); }`,
        filename: 'packages/desktop-client/src/components/App.tsx',
      },
      // Pattern 8 — a template-literal doing built only from allowed expressions
      {
        code: `try { await handler(req); } catch (err) { errors.caught(\`handling \${req.method} \${routeOf(req)}\`, err); }
try { go(); } catch (err) { errors.caught(\`handling \${def.method} \${def.path}\`, err); }
try { go(); } catch (err) { errors.caught(\`running \${action.type}\`, err); }
try { go(); } catch (err) { errors.caught(\`running the \${name} handler\`, err); }`,
        filename: 'packages/sync-server/src/machine/index.ts',
      },
      // Pattern 8 — .then(_, fn) that rethrows through the library
      {
        code: `handler(args).then(ok, err => { if (!isUserFacingError(err)) errors.rethrow(\`running the \${name} handler\`, err); throw err; });`,
        filename,
      },
      // Pattern 9 — captureException is a reporting net (N6)
      {
        code: `try { go(); } catch (e) { captureException(e); }`,
        filename,
      },
      // Pattern 10 — the top-level main().catch ends in fatal
      {
        code: `program.parseAsync(process.argv).catch((err) => { errors.fatal('running the actual CLI', err, { command: process.argv[2] ?? '' }); process.exitCode = 1; });`,
        filename: 'packages/cli/src/index.ts',
      },
      // A named handler is opaque to the rule and passes
      {
        code: `p.catch(handleFailure); q.then(ok, onFailure);`,
        filename,
      },
      // An ErrorFile under another name still counts, and *OrThrow is a hand-off
      {
        code: `try { go(); } catch (e) { workerErrors.warn('handling a worker message', e); }
try { go(); } catch (e) { assertOrThrow(e); }`,
        filename,
      },
      // The where literal matches the repo-relative path, without the packages/ prefix
      {
        code: `const errors = errorFileFor('loot-core/src/server/budgetfiles/app.ts');`,
        filename,
      },
      {
        code: `const errors = errorFileFor('cli/code/src/main.ts');`,
        filename: 'cli/code/src/main.ts',
      },
      // try/finally has no catch and is not a site (§6.11)
      {
        code: `try { go(); } finally { done(); }`,
        filename,
      },
    ],
    invalid: [
      // Pattern 1 — logger-only catch
      {
        code: `async function f() { try { await upload(); } catch (e) { logger.warn('Upload failed', e); return { error: 1 }; } }`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 1 — console-only catch
      {
        code: `try { go(); } catch (e) { console.error(e); }`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 2 — cleanup that swallows instead of rethrowing
      {
        code: `try { db.transaction(fn); } catch (e) { db.execQuery('ROLLBACK'); }`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 3 — the empty catch (optional catch binding)
      {
        code: `let cfg; try { cfg = JSON.parse(read()); } catch { cfg = {}; }`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      {
        code: `try { go(); } catch (e) {}`,
        filename,
        errors: [{ messageId: 'emptyCatch' }],
      },
      // Pattern 4 — the five-line fallback with a console report
      {
        code: `let parsed; try { parsed = JSON.parse(meta); } catch (e) { console.error(e); parsed = null; }`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 5 — .catch() that only logs, inline or by reference
      {
        code: `startWatcher().catch(err => console.log(err));`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      {
        code: `startWatcher().catch(console.error);`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      {
        code: `p.catch(() => {});`,
        filename,
        errors: [{ messageId: 'emptyCatch' }],
      },
      // Pattern 6 — an error listener that only logs
      {
        code: `window.addEventListener('error', ev => { console.log(ev); });`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 7 — ErrorBoundary onError that only logs
      {
        code: `const x = <ErrorBoundary onError={(e, info) => { console.error(e, info); }}><App /></ErrorBoundary>;`,
        filename: 'packages/desktop-client/src/components/App.tsx',
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 8 — .then(_, fn) that swallows
      {
        code: `handler(args).then(ok, err => { setState({ err }); });`,
        filename,
        errors: [{ messageId: 'unreported' }],
      },
      // Pattern 8 — an unstable doing (a request URL would fragment the fold key)
      {
        code: `try { go(); } catch (err) { errors.caught(\`handling \${req.url}\`, err); }`,
        filename: 'packages/sync-server/src/util/middlewares.ts',
        errors: [{ messageId: 'dynamicDoing' }],
      },
      {
        code: `try { go(); } catch (err) { errors.caught(message, err); }`,
        filename,
        errors: [{ messageId: 'dynamicDoing' }],
      },
      {
        code: `const v = tryOr(errors, 'reading ' + key, () => read(key), null);`,
        filename,
        errors: [{ messageId: 'dynamicDoing' }],
      },
      // Pattern 9/10 — the process-level last net must not swallow
      {
        code: `process.on('unhandledRejection', reason => { try { report(reason); } catch (e) { /* ignore */ } });`,
        filename: 'packages/sync-server/src/app.ts',
        errors: [{ messageId: 'emptyCatch' }],
      },
      {
        code: `main().catch(err => { process.stderr.write(String(err)); process.exit(1); });`,
        filename: 'packages/cli/src/index.ts',
        errors: [{ messageId: 'unreported' }],
      },
      // Companion check on where — fixable
      {
        code: `const errors = errorFileFor('packages/loot-core/src/server/budgetfiles/app.ts');`,
        filename,
        output: `const errors = errorFileFor('loot-core/src/server/budgetfiles/app.ts');`,
        errors: [{ messageId: 'wrongWhere' }],
      },
      {
        code: `const errors = errorFileFor(__filename);`,
        filename,
        output: `const errors = errorFileFor('loot-core/src/server/budgetfiles/app.ts');`,
        errors: [{ messageId: 'wrongWhere' }],
      },
      {
        code: `const errors = errorFileFor('mcp/src/index.ts');`,
        filename: 'mcp/src/server.ts',
        output: `const errors = errorFileFor('mcp/src/server.ts');`,
        errors: [{ messageId: 'wrongWhere' }],
      },
    ],
  },
  {
    parserOptions: {
      ecmaVersion: 2022,
      ecmaFeatures: { jsx: true },
      sourceType: 'module',
    },
  },
);
