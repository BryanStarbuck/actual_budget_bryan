import { errorFileFor } from '@actual-app/error-file';

import { run } from '#migrations';

const errors = errorFileFor('sync-server/src/scripts/run-migrations.js');

const direction = process.argv[2] || 'up';

run(direction).catch(err => {
  errors.fatal('running the database migrations', err, { direction });
  console.error('Migration failed:', err);
  process.exit(1);
});
