/* =========================================================
   document.js — menyatukan hasil per halaman menjadi satu tabel

   Yang ditangani di sini:
   - menyamakan model kolom antar halaman
   - mengenali baris header sekali saja
   - membuang header yang diulang di halaman berikutnya
   - menyambung baris yang terpotong pergantian halaman
   - merge ke bawah (rowspan) → isi turun / biarkan kosong / merge asli
   ========================================================= */

import { median, normalizeText, textSimilarity } from "./geometry.js";
import { analyzePage, assignToColumns, buildRows } from "./table.js";
import { buildGroupedPage, isNoValue, isSizeValue } from "./grouped.js";
import { buildCatalogDocumentTable } from "./catalog.js";

export function buildDocumentTable(pages, options = {}) {
  if (options.mode === "catalog") {
    // Catalog MUST consume the same per-page row model as the baseline
    // Adaptive engine. This prevents Catalog from silently losing rows
    // because it runs a second, slightly different row-building pipeline.
    const layouts = pages.map(page => analyzePage(page, { ...options, mode: "adaptive" }));
    inheritContinuationLayouts(pages, layouts);

    const catalogPageTables = pages.map((page, index) => {
      const layout = layouts[index];
      const rows = buildRows(page, layout, { ...options, mode: "adaptive" });
      const layoutHeader = materializeLayoutHeader(page, layout);
      if (layoutHeader) rows.unshift(layoutHeader);
      return {
        pageNumber: page.pageNumber,
        mode: layout.mode,
        columns: layout.columns,
        confidence: layout.confidence,
        rows
      };
    }).filter(t => t.rows.length);

    // Canonical data rows come from the already-approved Adaptive pipeline.
    // Catalog may reorganize/style them, but it must not create a second
    // source of truth for row extraction.
    const canonical = buildDocumentTable(pages, { ...options, mode: "adaptive" });

    return buildCatalogDocumentTable(
      pages,
      options,
      catalogPageTables,
      canonical.rows || []
    );
  }

  if (options.mode === "grouped") {
    return buildGroupedDocumentTable(pages, options);
  }

  const layouts = pages.map(page => analyzePage(page, options));

  inheritContinuationLayouts(pages, layouts);

  const pageTables = pages.map((page, index) => {
    const layout = layouts[index];
    const rows = buildRows(page, layout, options);
    const layoutHeader = materializeLayoutHeader(page, layout);

    if (layoutHeader) rows.unshift(layoutHeader);

    return {
      pageNumber: page.pageNumber,
      mode: layout.mode,
      columns: layout.columns,
      confidence: layout.confidence,
      rows
    };
  });

  const usable = pageTables.filter(table => table.rows.length);

  if (!usable.length) {
    const anyText = pages.some(page => page.hasText);
    const isOcr = options.inputSource === "ocr" || pages.some(page => page.ocr);

    throw new Error(
      anyText
        ? "Tidak ada struktur tabel yang terbaca. Coba ganti mode deteksi ke Garis border atau Celah spasi."
        : isOcr
          ? "OCR selesai tetapi tidak menghasilkan teks yang dapat dipakai untuk tabel."
          : "PDF ini tidak punya lapisan teks (kemungkinan hasil scan). Butuh OCR dulu."
    );
  }

  const columnCount = Math.max(
    ...usable.map(table => Math.max(...table.rows.map(row => row.cells.length), 0))
  );

  for (const table of usable) {
    for (const row of table.rows) padRow(row, columnCount);
  }

  const header = resolveHeader(usable, options);
  const body = collectBody(usable, header, options);

  const mergeMode = options.mergeMode ?? "fill";
  applyRowspan(body, mergeMode);

  if (mergeMode !== "merge") {
    for (const row of body) {
      row.cells = row.cells.map(cell =>
        cell ? { ...cell, colspan: 1, rowspan: 1 } : { text: "", colspan: 1, rowspan: 1 }
      );
    }
  }

  const layoutConfidences = usable
    .map(table => Number(table.confidence))
    .filter(Number.isFinite);

  return {
    header,
    rows: body,
    columnCount,
    modes: [...new Set(usable.map(table => table.mode))],
    pageCount: usable.length,
    confidence: layoutConfidences.length
      ? median(layoutConfidences)
      : null
  };
}

function buildGroupedDocumentTable(pages) {
  const parsed = pages.map(page => ({
    pageNumber: page.pageNumber,
    ...buildGroupedPage(page)
  }));

  const usable = parsed.filter(page => page.rows.length);
  if (!usable.length) {
    throw new Error("Mode Price list bertingkat tidak menemukan baris dengan pola harga. Gunakan mode Deteksi otomatis untuk tabel biasa.");
  }

  const header = usable.find(page => page.header)?.header || null;
  const rows = [];
  let currentNo = "";
  let currentSize = "";

  for (const page of usable) {
    for (const row of page.rows) {
      const no = normalizeText(row.cells[0]?.text || "");
      const size = normalizeText(row.cells[1]?.text || "");

      if (isNoValue(no)) currentNo = no;
      if (isSizeValue(size)) currentSize = size;

      row.cells[0].text = currentNo;
      row.cells[1].text = currentSize;
      row.page = page.pageNumber;
      rows.push(row);
    }
  }

  return {
    header,
    rows,
    columnCount: 4,
    modes: ["grouped"],
    pageCount: usable.length
  };
}

function materializeLayoutHeader(page, layout) {
  const header = layout?.adaptive?.header;
  if (!header || !layout.columns?.length) return null;

  const words = (page.words || []).filter(word => {
    const cy = (word.top + word.bottom) / 2;
    return cy >= header.y0 - 2 && cy <= header.y1 + 2;
  });

  if (!words.length) return null;

  const cells = assignToColumns(words, layout.columns).map(cell => ({
    text: normalizeText(cell.text),
    colspan: cell.colspan || 1,
    rowspan: 1
  }));

  if (!cells.some(cell => cell.text)) return null;

  return {
    cells,
    top: header.y0,
    bottom: header.y1,
    bold: words.filter(w => /bold|semibold|demi/i.test(String(w.fontFamily || ""))).length >= Math.ceil(words.length * 0.35),
    fontSize: median(words.map(w => Number(w.fontSize) || 0).filter(Boolean)) || 0,
    syntheticHeader: true,
    page: page.pageNumber
  };
}

function padRow(row, size) {
  while (row.cells.length < size) row.cells.push({ text: "", colspan: 1, rowspan: 1 });
  row.cells.length = size;
}

/* Continuation layout */

function inheritContinuationLayouts(pages, layouts) {
  for (let i = 1; i < pages.length; i++) {
    const current = layouts[i];
    const previous = layouts[i - 1];
    if (current?.columns?.length || !previous?.columns?.length || !pages[i].hasText) continue;

    const lines = current?.lines?.length ? current.lines : [];
    const firstWords = lines[0]?.words || [];
    if (!firstWords.length) continue;

    const pageWidth = pages[i].width || 595;
    const firstText = normalizeText(firstWords.map(w => w.text).join(" "));
    const firstSpan = Math.max(...firstWords.map(w => w.x1)) - Math.min(...firstWords.map(w => w.x0));
    const boldRatio = firstWords.filter(w => /bold|semibold|demi/i.test(String(w.fontFamily || ""))).length /
      Math.max(1, firstWords.length);
    const numericWords = firstWords.filter(w => /\d/.test(String(w.text || ""))).length;
    
    const looksLikeTitle =
      firstWords.length <= Math.max(3, Math.ceil(previous.columns.length / 2)) &&
      firstSpan >= pageWidth * 0.55 &&
      boldRatio >= 0.5 &&
      numericWords === 0 &&
      firstText.length >= 12;

    if (looksLikeTitle) continue;

    // Data continuation dideteksi secara struktural
    const looksLikeData =
      numericWords > 0 ||
      firstWords.length >= Math.min(3, previous.columns.length) ||
      firstSpan >= pageWidth * 0.35;

    if (!looksLikeData) continue;

    layouts[i] = {
      ...current,
      mode: "continuation-stream",
      columns: previous.columns.map(column => ({ ...column })),
      rowSeparators: null,
      grid: null,
      confidence: Math.min(Number(previous.confidence) || 0.65, 0.90),
      inheritedFromPage: pages[i - 1].pageNumber
    };
  }
}

/* Header */

const NUMERIC = /^[\s(]*[-+]?(?:rp|idr|usd|\$)?\s*[\d.,]+\s*%?\)?$/i;

function looksNumeric(value) {
  const text = normalizeText(value);

  if (!text || !NUMERIC.test(text) || !/\d/.test(text)) return false;
  if (/^[+-]?0\d/.test(text)) return false;

  return true;
}

function rowText(row) {
  return row.cells.map(cell => cell?.text || "").join(" | ");
}

function headerCellText(cell) {
  return normalizeText(cell?.text || "");
}

function isHeaderContinuationRow(row, header, columnCount) {
  if (!row || !header) return false;

  const cells = row.cells || [];
  const values = cells.map(headerCellText);
  const filled = values.filter(Boolean).length;
  if (!filled) return false;

  const numeric = values.filter(value => looksNumeric(value)).length;
  const codeLike = values[0] && (
    /^[A-Z]{0,6}\d[A-Z0-9._/-]{2,}$/i.test(values[0]) ||
    /^[+-]?0\d/.test(values[0])
  );

  if (numeric / Math.max(1, filled) >= 0.5) return false;
  if (codeLike && filled <= Math.max(2, Math.ceil(columnCount * 0.5))) return false;

  const gap = Number(row.top) - Number(header.bottom);
  if (!Number.isFinite(gap)) return false;

  return gap >= -1 && gap <= Math.max(16, (header.fontSize || 8) * 2.4);
}

function flattenMultiRowHeader(firstRow, continuationRows, columnCount) {
  const source = Array.from({ length: columnCount }, () => ({
    text: "",
    colspan: 1,
    rowspan: 1
  }));

  for (let c = 0; c < columnCount; c++) {
    const cell = firstRow.cells?.[c];
    if (!cell) continue;

    const text = headerCellText(cell);
    const span = Math.max(1, Number(cell.colspan) || 1);
    if (!text) continue;

    for (let k = c; k < Math.min(columnCount, c + span); k++) {
      source[k].text = text;
      source[k].colspan = 1;
    }
  }

  for (const row of continuationRows) {
    for (let c = 0; c < Math.min(columnCount, row.cells?.length || 0); c++) {
      const text = headerCellText(row.cells[c]);
      if (!text) continue;

      source[c].text = source[c].text
        ? `${source[c].text} ${text}`
        : text;
    }
  }

  const changed = source.some((cell, index) =>
    cell.text !== headerCellText(firstRow.cells?.[index])
  );

  if (!changed) return firstRow;

  return {
    ...firstRow,
    cells: source,
    colspan: 1,
    rowspan: 1,
    syntheticHeader: true,
    headerRowsMerged: 1 + continuationRows.length
  };
}

function resolveHeader(tables, options) {
  const setting = options.headerMode ?? "auto";
  if (setting === "none") return null;

  const first = tables[0];
  if (!first?.rows.length) return null;

  if (setting === "first") {
    return first.rows.shift();
  }

  const candidates = first.rows.slice(0, Math.min(15, first.rows.length));
  const bodySample = first.rows.slice(0, Math.min(20, first.rows.length));

  let best = null;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const cells = candidate.cells.map(cell => normalizeText(cell?.text));
    const filled = cells.filter(Boolean).length;
    if (!filled) continue;

    const nonEmptyRatio = filled / Math.max(1, cells.length);
    const text = cells.filter(Boolean).join(" | ");

    // Header harus lebih menyerupai label daripada nilai data.
    const numericCount = cells.filter(looksNumeric).length;
    const numericRatio = numericCount / Math.max(1, filled);

    let score = 0;

    // Posisi: header biasanya berada di bagian awal tabel, tetapi jangan
    // memaksa row pertama
    score += Math.max(0, 2.5 - index * 0.18);

    // Kepadatan cell.
    if (nonEmptyRatio >= 0.65) score += 2.2;
    else if (nonEmptyRatio >= 0.45) score += 1.0;

    // Label header biasanya tidak dominan numeric.
    if (numericRatio === 0) score += 2.0;
    else if (numericRatio < 0.25) score += 1.0;
    else score -= 2.0;

    // Bold/font sedikit membantu, tetapi bukan syarat.
    if (candidate.bold) score += 1.5;

    // Header text biasanya pendek/moderat per cell.
    const avgLen = cells.filter(Boolean)
      .reduce((sum, value) => sum + value.length, 0) / Math.max(1, filled);
    if (avgLen <= 35) score += 1.0;
    if (avgLen > 70) score -= 1.0;

    // Cari apakah row setelah kandidat mempunyai pola data yang konsisten
    // dengan kolom kandidat. Ini menjadi sinyal utama agar group row
    // seperti "AAS01A4B00000 | 50 SQPB/FC STD/BP" tidak dianggap header.
    const below = first.rows.slice(index + 1, Math.min(index + 11, first.rows.length));

    // Leading-zero ID/kode adalah data, bukan header. Karena looksNumeric()
    // sengaja menganggap 00123 sebagai text agar nol tidak hilang, kandidat
    // seperti ini perlu sinyal struktural tambahan supaya tidak menang.
    const firstCell = cells[0] || "";
    const codeLikeFirst =
      /^[+-]?0\d/.test(firstCell) ||
      /^[A-Z]{0,5}\d[A-Z0-9._\/-]{2,}$/i.test(firstCell);
    const repeatedCodeBelow = below
      .map(row => normalizeText(row.cells[0]?.text))
      .filter(value => /^[+-]?0\d/.test(value) || /^[A-Z]{0,5}\d[A-Z0-9._\/-]{2,}$/i.test(value))
      .length;

    if (codeLikeFirst && repeatedCodeBelow >= 2) score -= 4.0;
    if (below.length >= 2) {
      let usefulColumns = 0;
      let numericColumns = 0;

      for (let column = 0; column < cells.length; column++) {
        const values = below
          .map(row => normalizeText(row.cells[column]?.text))
          .filter(Boolean);

        if (values.length >= Math.max(2, Math.ceil(below.length * 0.35))) {
          usefulColumns++;
        }

        if (values.length >= 2) {
          const ratio = values.filter(looksNumeric).length / values.length;
          if (ratio >= 0.6) numericColumns++;
        }
      }

      score += Math.min(2.5, usefulColumns * 0.45);
      score += Math.min(1.5, numericColumns * 0.35);
    }

    // Group/section row biasanya sangat sedikit cell terisi dan memiliki
    // kode panjang di kolom pertama + deskripsi panjang. Penalti eksplisit.
    const codeLike = /^[A-Z0-9][A-Z0-9._\/-]{5,}$/i.test(firstCell);
    const looksSection =
      codeLike &&
      filled <= Math.max(2, Math.ceil(cells.length * 0.45)) &&
      text.length > 12;

    if (looksSection) score -= 3.5;

    // Header vocabulary hanya sebagai sinyal lemah/generic hint.
    // Tidak ada nama header yang diwajibkan.
    const labelLikeTokens = cells.filter(value =>
      /[A-Za-zÀ-ÿ]/.test(value) &&
      value.length >= 2 &&
      !/^\d/.test(value)
    ).length;

    if (labelLikeTokens >= Math.min(3, Math.max(1, cells.length - 1))) {
      score += 0.8;
    }

    // Kandidat yang sangat dekat dengan data numeric tetapi tidak punya
    // label text jangan dipilih.
    if (numericRatio > 0.5) score -= 2;

    if (!best || score > best.score) {
      best = { row: candidate, index, score };
    }
  }

  // Ambang konservatif. Jika tidak ada kandidat yang cukup kuat, jangan
  // mengarang header.
  if (!best || best.score < 5.0) return null;

  const columnCount = Math.max(
    first.rows.reduce((max, row) => Math.max(max, row.cells?.length || 0), 0),
    best.row.cells?.length || 0
  );

  // Header bertingkat/merged: gabungkan hanya baris yang sangat dekat dan
  // secara struktural terlihat seperti label header, bukan data.
  const continuationRows = [];
  for (let i = best.index + 1; i < Math.min(first.rows.length, best.index + 4); i++) {
    const row = first.rows[i];
    if (!isHeaderContinuationRow(row, best.row, columnCount)) break;
    continuationRows.push(row);
  }

  const mergedHeader = flattenMultiRowHeader(
    best.row,
    continuationRows,
    columnCount
  );

  const removeSet = new Set([best.row, ...continuationRows]);
  first.rows = first.rows.filter(row => !removeSet.has(row));

  return mergedHeader;
}

function collectBody(tables, header, options) {
  const rows = [];
  const joinAcrossPages = options.joinAcrossPages !== false;
  const headerText = header ? rowText(header) : null;

  for (const table of tables) {
    let pageRows = table.rows;

    // Header yang dicetak ulang di tiap halaman.
    if (headerText) {
      pageRows = pageRows.filter(row => textSimilarity(rowText(row), headerText) < 0.7);
    }

    for (let i = 0; i < pageRows.length; i++) {
      const row = pageRows[i];
      row.page = table.pageNumber;

      const previous = rows[rows.length - 1];

      const filledCount = row.cells.filter(cell => normalizeText(cell?.text)).length;
      const previousFilledCount = previous
        ? previous.cells.filter(cell => normalizeText(cell?.text)).length
        : 0;

      const isSpillover =
        joinAcrossPages &&
        i === 0 &&
        previous &&
        previous.page !== table.pageNumber &&
        !row.cells[0]?.text &&
        filledCount > 0 &&
        filledCount < row.cells.length &&
        previousFilledCount > 0;

      if (isSpillover) {
        row.cells.forEach((cell, index) => {
          if (!cell?.text) return;
          const target = previous.cells[index];
          target.text = target.text ? `${target.text} ${cell.text}` : cell.text;
        });
        continue;
      }

      rows.push(row);
    }
  }

  return rows;
}

/* ---------------------------------------------------------
   Merge ke bawah
   --------------------------------------------------------- */

function applyRowspan(rows, mode) {
  if (mode === "keep") return;

  // Mode lattice sudah tahu rowspan asli dari garis.
  const hasRealSpans = rows.some(row => row.cells.some(cell => (cell?.rowspan || 1) > 1));

  if (hasRealSpans) {
    if (mode !== "fill") return;

    rows.forEach((row, index) => {
      row.cells.forEach((cell, column) => {
        const span = cell?.rowspan || 1;
        if (span <= 1 || !cell.text) return;

        for (let k = 1; k < span && index + k < rows.length; k++) {
          const next = rows[index + k];
          if (next.page !== row.page) break; // jangan lompat halaman

          const target = next.cells[column];

          if (!target) {
            next.cells[column] = { text: cell.text, colspan: 1, rowspan: 1, filledDown: true };
          } else if (!target.text) {
            target.text = cell.text;
            target.filledDown = true;
          }
        }
      });
    });

    // Sel yang tersisa kosong karena merge tetap perlu wadah.
    for (const row of rows) {
      row.cells = row.cells.map(cell => cell || { text: "", colspan: 1, rowspan: 1 });
    }

    return;
  }

  if (mode !== "fill") return;

  // Tanpa garis: tebak merge dari pola kosong.
  const columnCount = rows[0]?.cells.length || 0;

  for (let column = 0; column < columnCount; column++) {
    const values = rows.map(row => normalizeText(row.cells[column]?.text));
    const filled = values.filter(Boolean);

    if (!filled.length) continue;

    const blankRatio = (values.length - filled.length) / values.length;
    if (blankRatio < 0.2) continue;

    // Kolom angka jangan diisi turun — nilainya memang beda tiap baris.
    const numericRatio = filled.filter(looksNumeric).length / filled.length;
    if (numericRatio > 0.6) continue;

    // Nilai yang berulang panjang = kandidat merge. Nilai yang selalu unik bukan.
    const unique = new Set(filled).size;
    if (unique / filled.length > 0.9 && blankRatio < 0.5) continue;

    let carry = "";

    for (const row of rows) {
      const cell = row.cells[column];
      if (!cell) continue;

      if (cell.text) {
        carry = cell.text;
      } else if (carry) {
        cell.text = carry;
        cell.filledDown = true;
      }
    }
  }
}

/* ---------------------------------------------------------
   Angka
   --------------------------------------------------------- */

export function parseNumber(value, locale = "auto") {
  if (locale === "off") return null;

  let text = normalizeText(value);
  if (!text || !/\d/.test(text)) return null;

  // Jangan konversi kode numerik dengan leading zero menjadi Number.
  // JavaScript akan mengubah 00123 menjadi 123 dan Excel tidak dapat
  // mengembalikan nol di depannya secara otomatis.
  if (/^[+-]?0\d/.test(text)) return null;

  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  const percent = /%$/.test(text);

  text = text
    .replace(/%/g, "")
    .replace(/(rp|idr|usd|eur|sgd|\$|€)/gi, "")
    .replace(/\s/g, "")
    .trim();

  if (/^-/.test(text)) {
    negative = true;
    text = text.slice(1);
  }

  if (!/^[\d.,]+$/.test(text)) return null;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");

  let decimalSeparator = null;

  if (lastDot >= 0 && lastComma >= 0) {
    decimalSeparator = lastDot > lastComma ? "." : ",";
  } else if (locale === "id") {
    decimalSeparator = lastComma >= 0 ? "," : null;
  } else if (locale === "en") {
    decimalSeparator = lastDot >= 0 ? "." : null;
  } else {
    const single = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (single) {
      const tail = text.length - text.lastIndexOf(single) - 1;
      const occurrences = text.split(single).length - 1;
      // "1.234" → pemisah ribuan. "1.5" atau "1.2345" → desimal.
      decimalSeparator = occurrences === 1 && tail !== 3 ? single : null;
    }
  }

  let normalized = text;

  if (decimalSeparator) {
    const other = decimalSeparator === "." ? "," : ".";
    normalized = normalized.split(other).join("");
    normalized = normalized.replace(decimalSeparator, ".");
  } else {
    normalized = normalized.replace(/[.,]/g, "");
  }

  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;

  const result = negative ? -number : number;
  return percent ? result / 100 : result;
}
