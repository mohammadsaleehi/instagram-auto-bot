/**
 * Handle the known node:sqlite ExperimentalWarning.
 *
 * Context:
 * - Node.js 22 ships `node:sqlite` as experimental.
 * - Builtin experimental warnings are printed even when a `warning` listener
 *   exists, so npm scripts also pass:
 *   `--disable-warning=ExperimentalWarning`
 * - That flag is name-scoped (not `--no-warnings`) and is documented in README.
 * - This listener remains as defense-in-depth for programmatic entrypoints and
 *   still re-prints any non-SQLite warnings if Node skips its default printer.
 */

let installed = false;

/**
 * @returns {void}
 */
export function installSqliteWarningFilter() {
  if (installed) {
    return;
  }
  installed = true;

  process.on('warning', (warning) => {
    const message = String(warning?.message ?? '');
    if (
      warning?.name === 'ExperimentalWarning' &&
      /sqlite/i.test(message)
    ) {
      return;
    }

    // If Node suppressed default printing because a listener exists, re-emit.
    const stack = warning?.stack;
    if (typeof stack === 'string' && stack.length > 0) {
      console.error(stack);
      return;
    }

    console.error(`${warning?.name ?? 'Warning'}: ${message}`);
  });
}
