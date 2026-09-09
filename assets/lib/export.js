/* =========================================================
   export.js — menulis hasil ke Excel / CSV
   ========================================================= */

import { normalizeText } from "./geometry.js";
import { parseNumber } from "./document.js";

export function buildWorksheet(table, options = {}) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error("Pustaka SheetJS belum termuat. Muat ulang halaman.");

  const locale = options.numberLocale ?? "auto";
  const keepMerges = options.mergeMode === "merge";

  const rows = [];
  if (table.header) rows.push(table.header);
  rows.push(...table.rows);

  const sheet = {};
  const merges = [];

  let maxColumn = Math.max(0, (table.columnCount || 1) - 1);

  rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (!cell) return;

      const text = normalizeText(cell.text);
      const address = XLSX.utils.encode_cell({ r, c });

      const isHeaderRow = Boolean(table.header) && r === 0;
      const numeric = isHeaderRow ? null : parseNumber(text, locale);

      if (numeric !== null) {
        sheet[address] = { t: "n", v: numeric };
      } else if (text) {
        sheet[address] = { t: "s", v: text };
      } else {
        sheet[address] = { t: "s", v: "" };
      }

      if (keepMerges) {
        const colspan = cell.colspan || 1;
        const rowspan = cell.rowspan || 1;

        if (colspan > 1 || rowspan > 1) {
          merges.push({
            s: { r, c },
            e: { r: r + rowspan - 1, c: c + colspan - 1 }
          });
        }
      }

      maxColumn = Math.max(maxColumn, c);
    });
  });

  sheet["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(0, rows.length - 1), c: maxColumn }
  });

  sheet["!cols"] = buildColumnWidths(rows, maxColumn + 1);

  if (merges.length) sheet["!merges"] = merges;

  if (table.header) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(0, rows.length - 1), c: maxColumn }
      })
    };
  }

  return sheet;
}

function buildColumnWidths(rows, count) {
  const sample = rows.slice(0, 400);

  return Array.from({ length: count }, (_, index) => {
    let longest = 0;

    for (const row of sample) {
      const text = normalizeText(row.cells[index]?.text);
      longest = Math.max(longest, text.length);
    }

    return { wch: Math.min(Math.max(longest + 2, 9), 60) };
  });
}

export function downloadWorkbook(table, fileName, options) {
  const XLSX = window.XLSX;
  const sheet = buildWorksheet(table, options);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Tabel");

  XLSX.writeFile(book, fileName);
}

export function downloadCsv(table, fileName, options) {
  const XLSX = window.XLSX;
  const sheet = buildWorksheet(table, { ...options, mergeMode: "fill" });

  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: options?.csvDelimiter || "," });
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  link.click();

  URL.revokeObjectURL(url);
}
