/* Catalog-only Excel exporter.
   This module is intentionally isolated from assets/lib/export.js.
   It loads xlsx-js-style on demand so Adaptive/OCR/Lattice/Stream keep the
   baseline SheetJS exporter and library. */

import { normalizeText } from "./geometry.js";
import { parseNumber } from "./document.js";

let styleXlsxPromise = null;

function loadStyleXlsx() {
  if (window.XLSX && window.XLSX.__catalogStyleEngine) return Promise.resolve(window.XLSX);
  if (styleXlsxPromise) return styleXlsxPromise;

  styleXlsxPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-catalog-xlsx-style="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.XLSX));
      existing.addEventListener("error", reject);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js";
    script.dataset.catalogXlsxStyle = "1";
    script.onload = () => {
      if (!window.XLSX) {
        reject(new Error("Library xlsx-js-style gagal dimuat."));
        return;
      }
      window.XLSX.__catalogStyleEngine = true;
      resolve(window.XLSX);
    };
    script.onerror = () => reject(new Error("Gagal memuat xlsx-js-style untuk Catalog."));
    document.head.appendChild(script);
  });

  return styleXlsxPromise;
}

const COLORS = {
  header: "1F4E78",
  header2: "D9EAF7",
  section: "DCE6F1",
  sectionText: "17365D",
  body: "FFFFFF",
  border: "7F7F7F",
  white: "FFFFFF",
  black: "000000"
};

function thinBorder() {
  return {
    top: { style: "thin", color: { rgb: COLORS.border } },
    bottom: { style: "thin", color: { rgb: COLORS.border } },
    left: { style: "thin", color: { rgb: COLORS.border } },
    right: { style: "thin", color: { rgb: COLORS.border } }
  };
}

function getCellHeaderText(row, col) {
  const cell = row?.cells?.[col];
  return normalizeText(
    cell?.headerText ??
    cell?.columnName ??
    row?.columns?.[col]?.name ??
    ""
  );
}

function isNumericLike(text) {
  const s = normalizeText(text);
  return /^[-+]?(?:\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,]\d+)?%?$/.test(s);
}

function columnIsNumeric(row, col) {
  const header = getCellHeaderText(row, col);
  if (/(qty|quantity|harga|price|amount|total|rp|idr|numeric|number|no\.?)/i.test(header)) {
    return true;
  }
  return col === 0 || isNumericLike(row?.cells?.[col]?.text || "");
}

function styleFor(role, row, col, isSubHeader = false) {
  if (role === "header" || isSubHeader) {
    const level = Number(row?.catalogHeaderLevel || (isSubHeader ? 2 : 1));
    const primary = level <= 1;

    return {
      fill: { patternType: "solid", fgColor: { rgb: primary ? COLORS.header : COLORS.header2 } },
      font: {
        bold: true,
        color: { rgb: primary ? COLORS.white : COLORS.black }
      },
      alignment: {
        horizontal: "center",
        vertical: "center",
        wrapText: true
      },
      border: thinBorder()
    };
  }

  if (role === "section") {
    return {
      fill: { patternType: "solid", fgColor: { rgb: COLORS.section } },
      font: { bold: true, color: { rgb: COLORS.sectionText } },
      alignment: {
        horizontal: "left",
        vertical: "center",
        wrapText: true
      },
      border: thinBorder()
    };
  }

  const numeric = columnIsNumeric(row, col);
  return {
    fill: { patternType: "solid", fgColor: { rgb: COLORS.body } },
    font: { color: { rgb: COLORS.black } },
    alignment: {
      horizontal: numeric ? "center" : "left",
      vertical: "center",
      wrapText: true
    },
    border: thinBorder()
  };
}

function rowRole(row, index, headerCount) {
  if (row?.catalogRole) return row.catalogRole;
  if (index < headerCount) return "header";
  return "body";
}

function setMerge(sheet, merges, r, c, rowspan, colspan) {
  if (rowspan <= 1 && colspan <= 1) return;
  merges.push({
    s: { r, c },
    e: { r: r + rowspan - 1, c: c + colspan - 1 }
  });
}

function rowTextForExport(row) {
  return (row?.cells || []).map(c => normalizeText(c?.text || "")).join(" | ");
}

function buildCatalogSheet(XLSX, table, options) {
  // IMPORTANT: Preview is the canonical Catalog result. The exporter must not
  // re-classify, deduplicate, or truncate rows here. Doing so caused valid
  // Sandvik product codes such as "1075 16-101" and "131-2005-B" to disappear
  // after Preview had already found all 64 rows.
  //
  // Catalog structural cleanup belongs in catalog.js. At this boundary we
  // serialize exactly the rows delivered by Preview, preserving their physical
  // order and duplicate occurrences when they are genuinely present.
  const rows = [
    ...(table.leadingRows || []),
    ...(table.headerRows || []),
    ...(table.rows || [])
  ].filter(row =>
    (row?.cells || []).some(cell => normalizeText(cell?.text || ""))
  );

  const headerCount =
    (table.leadingRows?.length || 0) +
    (table.headerRows?.length || 0);

  const sheet = {};
  const merges = [];
  const widths = [];
  const heights = [];
  const mergeMode = options?.mergeMode || "merge";

  rows.forEach((row, r) => {
    const role = rowRole(row, r, headerCount);
    const level = Number(row?.catalogHeaderLevel || 1);

    // Generic height: multiline/header rows get more room.
    const maxLines = Math.max(
      1,
      ...(row?.cells || []).map(cell =>
        String(cell?.text || "").split(/\r?\n/).length
      )
    );

    const baseHeight =
      role === "header" ? (level <= 1 ? 32 : 25) :
      role === "section" ? 24 : 21;

    heights.push({
      hpt: Math.min(72, Math.max(baseHeight, baseHeight + (maxLines - 1) * 11))
    });

    (row.cells || []).forEach((cell, c) => {
      if (!cell) return;

      const text = normalizeText(cell.text || "");
      const address = XLSX.utils.encode_cell({ r, c });

      // Keep original textual values that are not safely numeric.
      // parseNumber is used only when the source text is unambiguously numeric.
      const parsed = role === "body"
        ? parseNumber(text, options?.numberLocale ?? "auto")
        : null;

      const value = parsed !== null && !/[A-Za-z]/.test(text.replace(/(?:IDR|RP)/ig, ""))
        ? { t: "n", v: parsed }
        : { t: "s", v: text };

      value.s = styleFor(role, row, c);
      sheet[address] = value;

      const colspan = Math.max(1, Number(cell.colspan || 1));
      const rowspan = Math.max(1, Number(cell.rowspan || 1));

      if (mergeMode === "merge") {
        setMerge(sheet, merges, r, c, rowspan, colspan);
      }

      // Estimate width from visible text, capped so long descriptions don't
      // make the whole workbook unusably wide.
      const visibleLen = Math.max(
        ...String(text).split(/\r?\n/).map(s => s.length),
        1
      );
      const ideal = c === 1
        ? Math.min(55, Math.max(18, visibleLen * 0.9 + 3))
        : Math.min(24, Math.max(8, visibleLen * 0.85 + 2));

      widths[c] = Math.max(widths[c] || 8, ideal);
    });
  });

  const columnCount = Math.max(
    Number(table.columnCount || 0),
    ...rows.map(row => (row.cells || []).length),
    1
  );

  sheet["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(0, rows.length - 1), c: columnCount - 1 }
  });

  sheet["!merges"] = merges;
  sheet["!cols"] = Array.from({ length: columnCount }, (_, c) => ({
    wch: Math.min(55, Math.max(8, widths[c] || 12))
  }));
  sheet["!rows"] = heights;

  // xlsx-js-style understands the standard SheetJS freeze-pane structure
  // through !freeze in supported builds; keep it only when there are headers.
  if (headerCount > 0) {
    sheet["!freeze"] = { xSplit: 0, ySplit: headerCount };
  }

  // Useful when a catalog table has a clear header.
  if (headerCount > 0 && columnCount > 0 && rows.length > headerCount) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: Math.max(0, headerCount - 1), c: 0 },
        e: { r: rows.length - 1, c: columnCount - 1 }
      })
    };
  }

  return sheet;
}

export async function downloadCatalogWorkbook(table, fileName, options = {}) {
  const baselineXlsx = window.XLSX;
  const XLSX = await loadStyleXlsx();

  try {
    const book = XLSX.utils.book_new();
    const sheets = Array.isArray(table?.sheets) && table.sheets.length
      ? table.sheets
      : [table];

    sheets.forEach((subtable, index) => {
      const sheet = buildCatalogSheet(XLSX, subtable, options);
      const rawName = subtable.name || `Table ${index + 1}`;
      const safeName = String(rawName)
        .replace(/[\\/?*[\]:]/g, " ")
        .trim()
        .slice(0, 31) || `Table ${index + 1}`;
      XLSX.utils.book_append_sheet(book, sheet, safeName);
    });

    XLSX.writeFile(book, fileName);
  } finally {
    // Keep the baseline SheetJS reference for subsequent non-Catalog exports.
    if (baselineXlsx && !baselineXlsx.__catalogStyleEngine) {
      window.XLSX = baselineXlsx;
    }
  }
}
