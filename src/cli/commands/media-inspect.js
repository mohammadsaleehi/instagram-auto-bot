#!/usr/bin/env node
import {
  createTheme,
  installSqliteWarningFilter,
  renderError,
  writeJson,
  writeOutput,
} from '../ui/index.js';
import { parseContentArgs } from '../ui/content-args.js';
import { contentErrorPayload, openContentRuntime } from '../content-runtime.js';

installSqliteWarningFilter();

async function main() {
  const args = parseContentArgs();
  const theme = createTheme();
  const selector = args.positionals[0] || '';

  if (args.help || !selector) {
    writeOutput(
      theme,
      [
        'Usage: npm run media:inspect -- <filename-or-path> [--json]',
        'Validates an exact Story media file (magic-byte MIME, size, dimensions).',
      ].join('\n'),
    );
    if (!selector && !args.help) {
      process.exitCode = 1;
    }
    return;
  }

  const runtime = openContentRuntime();
  try {
    const filePath = await runtime.storyMediaInbox.resolveExact(selector);
    const inspected = await runtime.storyMediaInbox.inspectFile(filePath);
    if (args.json) {
      writeJson(theme, { ok: inspected.valid, media: inspected });
      return;
    }

    const lines = [
      `File: ${inspected.filePath}`,
      `Name: ${inspected.fileName}`,
      `MIME: ${inspected.mimeType} (${inspected.mediaKind})`,
      `Size: ${inspected.byteSize} bytes`,
      `Dimensions: ${inspected.width ?? '?'}x${inspected.height ?? '?'}`,
      `Checksum: ${inspected.checksumSha256 ?? 'n/a'}`,
      `Valid: ${inspected.valid ? 'yes' : 'no'}`,
    ];
    if (inspected.error) {
      lines.push(`Error: ${inspected.error}`);
    }
    if (inspected.warnings?.length) {
      lines.push('Warnings:');
      for (const warning of inspected.warnings) {
        lines.push(`  - ${warning}`);
      }
    }
    writeOutput(theme, lines.join('\n'));
    if (!inspected.valid) {
      process.exitCode = 1;
    }
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
