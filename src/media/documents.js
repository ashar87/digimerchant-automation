import ExcelJS from 'exceljs';
import { log } from '../logger.js';

/**
 * Spreadsheets can't be handed to a model directly, so they become a compact text
 * table. Capped hard — a 10,000-row stock report would swamp the conversation and
 * the task is almost always in the first screenful anyway.
 */
const MAX_ROWS_PER_SHEET = 60;
const MAX_SHEETS = 5;

export async function sheetToText(attachment) {
  try {
    if (attachment.mime === 'text/csv') {
      const text = Buffer.from(attachment.data, 'base64').toString('utf8');
      return trimLines(text, MAX_ROWS_PER_SHEET);
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(attachment.data, 'base64'));

    const out = [];
    for (const sheet of wb.worksheets.slice(0, MAX_SHEETS)) {
      const rows = [];
      sheet.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > MAX_ROWS_PER_SHEET) return;
        const cells = row.values.slice(1).map((v) => cellText(v));
        if (cells.some((c) => c !== '')) rows.push(cells.join(' | '));
      });
      if (rows.length) {
        const more = sheet.rowCount > MAX_ROWS_PER_SHEET ? `\n… (${sheet.rowCount - MAX_ROWS_PER_SHEET} more rows)` : '';
        out.push(`### Sheet: ${sheet.name}\n${rows.join('\n')}${more}`);
      }
    }
    return out.join('\n\n') || null;
  } catch (err) {
    log.warn(`could not read spreadsheet ${attachment.filename || ''}:`, err.message);
    return null;
  }
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.result !== undefined) return String(v.result);      // formula
    if (v.text !== undefined) return String(v.text);          // rich text / hyperlink
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).trim();
}

function trimLines(text, max) {
  const lines = text.split('\n').filter((l) => l.trim());
  const kept = lines.slice(0, max).join('\n');
  return lines.length > max ? `${kept}\n… (${lines.length - max} more rows)` : kept;
}
