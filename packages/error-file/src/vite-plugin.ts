// NODE ONLY — mounts POST /error-report on the Vite dev server (pm/error_err.mdx §4.5, N20), so
// `yarn start` (:3001) writes browser faults without a sync server running.
//
// Zero dependencies: the plugin is typed structurally instead of importing `vite`.

import { createErrorReportHandler } from './ingest.ts';
import { installNodeErrorFile } from './node.ts';

type Middlewares = {
  use(
    path: string,
    handler: ReturnType<typeof createErrorReportHandler>,
  ): unknown;
};

export type ErrorReportVitePlugin = {
  name: string;
  configureServer(server: { middlewares: Middlewares }): void;
  configurePreviewServer(server: { middlewares: Middlewares }): void;
};

export function errorReportVitePlugin(): ErrorReportVitePlugin {
  function mount(server: { middlewares: Middlewares }): void {
    try {
      // The dev server is a library host here: never take over its process handlers.
      installNodeErrorFile({
        app: 'vite',
        where: 'error-file/src/vite-plugin.ts',
        handleProcessErrors: false,
        onlyIfNoSink: true,
      });
      server.middlewares.use(
        '/error-report',
        createErrorReportHandler({ via: 'vite' }),
      );
    } catch {
      // R11: the error file must never stop the dev server from starting
    }
  }
  return {
    name: 'actual-error-report',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
