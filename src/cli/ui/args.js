/**
 * Minimal argv parser for CLI presentation flags.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {{
 *   json: boolean,
 *   verbose: boolean,
 *   limit: number | null,
 *   help: boolean,
 *   positionals: string[],
 * }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  /** @type {string[]} */
  const positionals = [];
  let json = false;
  let verbose = false;
  let help = false;
  /** @type {number | null} */
  let limit = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--limit' || arg === '-n') {
      const next = argv[i + 1];
      const parsed = Number.parseInt(next ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      continue;
    }
    if (/^\d+$/.test(arg) && limit === null) {
      // Backward-compatible: `npm run jobs -- 50`
      limit = Number.parseInt(arg, 10);
      continue;
    }
    positionals.push(arg);
  }

  return { json, verbose, limit, help, positionals };
}
