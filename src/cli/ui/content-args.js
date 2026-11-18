/**
 * Argv parser for content-management CLI commands.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 */
export function parseContentArgs(argv = process.argv.slice(2)) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string | boolean | string[]>} */
  const flags = {};
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
    if (arg === '--confirm') {
      flags.confirm = true;
      continue;
    }
    if (arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (arg === '--no-dry-run') {
      flags.dryRun = false;
      continue;
    }
    if (arg === '--enqueue') {
      flags.enqueue = true;
      continue;
    }
    if (arg === '--inline') {
      flags.enqueue = false;
      continue;
    }
    if (arg === '--missed') {
      flags.missed = true;
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
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const key = camelFlag(arg.slice(2, eq));
      const value = arg.slice(eq + 1);
      appendFlag(flags, key, value);
      continue;
    }
    if (arg.startsWith('--')) {
      const key = camelFlag(arg.slice(2));
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        appendFlag(flags, key, next);
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(arg);
  }

  return { json, verbose, help, limit, positionals, flags };
}

/**
 * @param {string} name
 */
function camelFlag(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * @param {Record<string, string | boolean | string[]>} flags
 * @param {string} key
 * @param {string} value
 */
function appendFlag(flags, key, value) {
  if (key === 'media' || key === 'hashtag' || key === 'hashtags') {
    const normalizedKey = key === 'hashtag' ? 'hashtags' : key;
    const existing = flags[normalizedKey];
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (Array.isArray(existing)) {
      existing.push(...parts);
    } else if (typeof existing === 'string') {
      flags[normalizedKey] = [existing, ...parts];
    } else {
      flags[normalizedKey] = parts;
    }
    return;
  }
  flags[key] = value;
}
