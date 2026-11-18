import fs from 'node:fs';
import { IntelligenceError } from '../constants.js';

/**
 * Minimal CSV parser supporting quoted fields.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((cell) => String(cell).trim() !== ''));
}

/**
 * @param {string} filePath
 */
export function readCsvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new IntelligenceError(`CSV file not found: ${filePath}`, {
      code: 'IMPORT_FILE_NOT_FOUND',
      details: { filePath },
    });
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const matrix = parseCsvText(text);
  if (matrix.length === 0) {
    throw new IntelligenceError('CSV file is empty', { code: 'IMPORT_EMPTY' });
  }

  const headers = matrix[0].map((header) => String(header ?? '').trim());
  const rows = matrix.slice(1).map((cells) => {
    /** @type {Record<string, unknown>} */
    const row = {};
    headers.forEach((header, index) => {
      row[header || `column_${index + 1}`] = cells[index] ?? '';
    });
    return row;
  });

  return {
    sourceType: 'csv',
    worksheets: [
      {
        name: 'Sheet1',
        headers: headers.map((header, index) => header || `column_${index + 1}`),
        rows,
      },
    ],
  };
}
