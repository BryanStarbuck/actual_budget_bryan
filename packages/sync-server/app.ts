import { errorFileFor } from '@actual-app/error-file';
import { installNodeErrorFile } from '@actual-app/error-file/node';

import { run as runMigrations } from './src/migrations';

// pm/error_err.mdx §7 N9/N12: the process entry installs the node sink before anything else runs,
// so a migration fault is in the file too. run() repeats the call (idempotent) for other hosts.
installNodeErrorFile({
  app: 'sync-server',
  where: 'sync-server/app.ts',
  crashOnUnhandledRejection: false,
});
const errors = errorFileFor('sync-server/app.ts');

runMigrations()
  .then(() => {
    //import the app here becasue initial migrations need to be run first - they are dependencies of the app.js
    void import('./src/app.js').then(app => app.run()); // run the app
  })
  .catch(err => {
    errors.fatal('starting the sync server', err);
    console.log('Error starting app:', err);
    process.exit(1);
  });
