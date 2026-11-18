#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { renderContentDetail } from '../ui/render/content.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();

  if (args.help) {
    writeOutput(
      theme,
      [
        'Usage: npm run content:create -- --title="Post" --type=IMAGE --caption="..." --media=./photo.jpg [--hashtags=tag1,tag2] [--json]',
        'Non-interactive flags are required for automation.',
      ].join('\n'),
    );
    return;
  }

  const title = args.flags.title ? String(args.flags.title) : '';
  const media = Array.isArray(args.flags.media)
    ? args.flags.media.map(String)
    : args.flags.media
      ? [String(args.flags.media)]
      : [];

  if (!title || media.length === 0) {
    const message = 'Provide --title and at least one --media path';
    if (args.json) {
      writeJson(theme, { ok: false, error: { message, code: 'USAGE' } });
    } else {
      writeOutput(theme, renderError(theme, message), 'stderr');
    }
    process.exitCode = 1;
    return;
  }

  const runtime = openContentRuntime();
  try {
    const hashtags = Array.isArray(args.flags.hashtags)
      ? args.flags.hashtags
      : args.flags.hashtags
        ? String(args.flags.hashtags).split(/[\s,]+/)
        : [];

    const item = await runtime.service.createDraft({
      title,
      description: args.flags.description ? String(args.flags.description) : '',
      caption: args.flags.caption ? String(args.flags.caption) : '',
      hashtags,
      contentType: args.flags.type ? String(args.flags.type) : 'IMAGE',
      mediaPaths: media,
    });

    if (args.json) {
      writeJson(theme, { ok: true, item });
      return;
    }

    writeOutput(
      theme,
      renderContentDetail(item, theme, { timezone: runtime.config.appTimezone }),
    );
  } catch (error) {
    if (args.json) {
      writeJson(theme, contentErrorPayload(error));
    } else {
      writeOutput(theme, renderError(theme, error instanceof Error ? error.message : String(error)), 'stderr');
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

main();
