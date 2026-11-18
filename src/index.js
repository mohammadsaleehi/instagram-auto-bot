import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application } from './core/application.js';
import { installSqliteWarningFilter } from './cli/ui/warnings.js';

installSqliteWarningFilter();

// Re-export legacy helpers used by existing tests.
export { waitUntilStopped } from './legacy/wait-until-stopped.js';
export { Application };

/**
 * Application entry used by npm start and unit tests.
 *
 * @param {ConstructorParameters<typeof Application>[0]} [options]
 * @returns {Promise<void>}
 */
export async function main(options = {}) {
  const app = new Application(options);
  await app.start();
}

/**
 * @returns {boolean}
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
