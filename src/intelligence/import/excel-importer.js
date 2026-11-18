import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { IntelligenceError } from '../constants.js';

/**
 * @param {string} filePath
 */
export function readExcelFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new IntelligenceError(`Excel file not found: ${filePath}`, {
      code: 'IMPORT_FILE_NOT_FOUND',
      details: { filePath },
    });
  }

  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { cellDates: true });
  } catch (error) {
    throw new IntelligenceError(`Failed to read Excel file: ${filePath}`, {
      code: 'IMPORT_EXCEL_READ_FAILED',
      cause: error,
    });
  }

  const worksheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false,
    });
    const nonEmpty = matrix.filter((row) =>
      Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''),
    );
    if (nonEmpty.length === 0) {
      return { name, headers: [], rows: [] };
    }
    const headerRow = nonEmpty[0].map((cell, index) => {
      const text = String(cell ?? '').trim();
      return text || `column_${index + 1}`;
    });
    const rows = nonEmpty.slice(1).map((cells) => {
      /** @type {Record<string, unknown>} */
      const row = {};
      headerRow.forEach((header, index) => {
        row[header] = cells[index] ?? '';
      });
      return row;
    });
    return { name, headers: headerRow, rows };
  });

  return {
    sourceType: 'excel',
    worksheets,
  };
}
