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
        'Usage: npm run story:create -- --title="Story" --type=IMAGE|VIDEO --media=./story.jpg [--group=campaign] [--order=0] [--json]',
        'Creates a STORY draft. --type is the Story media kind (IMAGE or VIDEO), not a feed post type.',
        'Captions/hashtags are not used for Stories (unsupported by the public Content Publishing API).',
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
    const message = 'Provide --title and exactly one --media path';
    if (args.json) {
      writeJson(theme, { ok: false, error: { message, code: 'USAGE' } });
    } else {
      writeOutput(theme, renderError(theme, message), 'stderr');
    }
    process.exitCode = 1;
    return;
  }

  if (media.length !== 1) {
    const message = 'Stories require exactly one --media file';
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
    const item = await runtime.service.createStoryDraft({
      title,
      description: args.flags.description ? String(args.flags.description) : '',
      type: args.flags.type ? String(args.flags.type) : undefined,
      mediaPaths: media,
      group: args.flags.group ? String(args.flags.group) : null,
      order: args.flags.order != null ? Number(args.flags.order) : 0,
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
      writeOutput(
        theme,
        renderError(theme, error instanceof Error ? error.message : String(error)),
        'stderr',
      );
    }
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

main();
