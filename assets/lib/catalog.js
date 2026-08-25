/* =========================================================
   catalog.js — Catalog V4 / generic structural multi-table mode

   Design goals:
   - Do NOT hard-code vendor/category names.
   - A page may contain multiple independent tables.
   - A table may continue to the next page without repeating a header.
   - Repeated headers start a new table only when they appear after data.
   - Multiline/wrapped text stays inside the same physical row when the
     detector already assigned it to the same cell.
   - Header rows are inferred from text density, boldness, and numeric data.
   - Section/title rows are preserved as structural rows, not treated as data.
   - Excel merges are inferred generically from header geometry.
   ========================================================= */

import { analyzePage, buildRows } from "./table.js";
import { median, normalizeText, textSimilarity } from "./geometry.js";

const GENERIC_HEADER_WORDS = [
  "no", "item", "code", "pn", "product", "description", "desc", "name",
  "qty", "quantity", "pack", "size", "unit", "price", "het", "retail",
  "eceran", "application", "aplikasi", "status", "volt", "pin", "ampere",
  "type", "model", "capacity", "weight", "spec", "rp", "idr", "usd"
];

const PRICEISH = /(?:rp\.?|idr|usd|\$)?\s*\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\b\d+(?:[.,]\d{3})+(?:[.,]\d+)?\b/i;
const INTEGERISH = /^\d{1,4}$/;

export function buildCatalogDocumentTable(
  pages,
  options = {},
  baselinePageTables = null,
  canonicalRows = []
) {
  const pageBlocks = [];
  const pageTables = [];
  let sourceRowCount = canonicalRows.length || 0;
  const seenSourceTableFingerprints = new Set();
  const seenPageBlockFingerprints = new Set();

  const sourceTables = baselinePageTables || pages.map(page => ({
    pageNumber: page.pageNumber,
    mode: "adaptive",
    confidence: null,
    rows: []
  }));

  for (const sourceTable of sourceTables) {
    const pageNumber = sourceTable.pageNumber;
    const page = pages.find(p => p.pageNumber === pageNumber) || pages[0];
    const rows = (sourceTable.rows || []).filter(row =>
      row?.cells?.some(cell => normalizeText(cell?.text || ""))
    );
    if (!rows.length) continue;

    const sourceFingerprint = [
      pageNumber,
      rows.map(row => canonicalRowKey(normalizeRow(row, pageNumber, -1))).join("\u001e")
    ].join("\u001f");

    // Adaptive page tables can contain the same physical table more than once
    // (e.g. when a page was discovered through overlapping extraction paths).
    // Drop only an exact table duplicate on the same page; legitimate duplicate
    // product rows inside one source table are preserved.
    if (seenSourceTableFingerprints.has(sourceFingerprint)) continue;
    seenSourceTableFingerprints.add(sourceFingerprint);
    const normalized = rows.map((row, index) => normalizeRow(row, pageNumber, index));
    const blocks = splitPageIntoTableBlocks(normalized, page);

    for (const block of blocks) {
      if (!block.rows.length) continue;

      const headerInfo = inferHeaderRows(block.rows);
      const headerRows = cloneRows(headerInfo.rows);
      let bodyRows = cloneRows(block.rows.slice(headerInfo.count));
      const leadingRows = cloneRows(headerInfo.leadingRows);

      // A repeated PDF header can occur at the bottom of a physical page/table
      // after the product rows. It is structural, not product data.
      // Remove only rows that match the already-detected header signature.
      if (headerRows.length) {
        const headerKeys = headerRows.map(canonicalRowKey);
        bodyRows = bodyRows.filter(row => {
          const key = canonicalRowKey(row);
          return !headerKeys.includes(key) && !headerRows.some(h =>
            textSimilarity(rowText(row), rowText(h)) >= 0.92
          );
        });
      }

      // A page containing only a company cover/contact/footer block must not
      // become a Catalog sheet. Product tables require at least one data row.
      if (!bodyRows.some(isDataRow)) continue;
      const columnCount = Math.max(
        1,
        sourceTable.columns?.length || 0,
        ...block.rows.map(row => row.cells.length)
      );

      for (const row of [...leadingRows, ...headerRows, ...bodyRows]) padRow(row, columnCount);

      const accountedRows = leadingRows.length + headerRows.length + bodyRows.length;
      if (accountedRows !== block.rows.length) {
        throw new Error(
          `Catalog row accounting mismatch on page ${pageNumber}: ` +
          `${block.rows.length} source rows, ${accountedRows} accounted rows.`
        );
      }

      const blockFingerprint = [
        pageNumber,
        canonicalRowKey(headerRows[0] || { cells: [] }),
        bodyRows.map(canonicalRowKey).join("\u001e"),
        leadingRows.map(canonicalRowKey).join("\u001e")
      ].join("\u001f");

      if (seenPageBlockFingerprints.has(blockFingerprint)) continue;
      seenPageBlockFingerprints.add(blockFingerprint);

      pageBlocks.push({
        pageNumber,
        rows: bodyRows,
        headerRows,
        leadingRows,
        columnCount,
        schema: schemaSignature(headerRows, columnCount),
        firstData: firstDataSignature(bodyRows),
        sectionKey: sectionIdentity(leadingRows, columnCount),
        confidence: Number.isFinite(sourceTable.confidence) ? sourceTable.confidence : null,
        mode: sourceTable.mode || "adaptive",
        bbox: block.bbox
      });
    }

    pageTables.push({ pageNumber: page.pageNumber, blocks: blocks.length });
  }

  if (!pageBlocks.length) {
    throw new Error("Mode Catalog tidak menemukan struktur tabel yang dapat dibaca.");
  }

  const logical = [];
  let current = null;

  for (let i = 0; i < pageBlocks.length; i++) {
    const block = pageBlocks[i];
    const previous = i > 0 ? pageBlocks[i - 1] : null;

    if (!current) {
      current = createLogicalTable(block);
      continue;
    }

    if (isContinuation(block, current, previous)) {
      appendBlock(current, block);
    } else {
      logical.push(finalizeLogicalTable(current));
      current = createLogicalTable(block);
    }
  }

  if (current) logical.push(finalizeLogicalTable(current));

  // NESTED TABLE RECONCILIATION
  //
  // Some PDF detectors emit the same physical table twice:
  //   A = title/subtitle + data 1..N
  //   B = canonical header + data 1..M, where M > N
  //
  // Do NOT rely on CatalogRole/leadingRows here: a title-only block can be
  // classified as body by the detector. The only merge signal used here is
  // exact data-prefix identity plus physical page proximity and a strictly
  // richer following table. This keeps unrelated sections isolated.
  function mergeNestedPrefixTables(logicalTables) {
    const out = [];

    const dataRows = table =>
      (table.rows || []).filter(isDataRow);

    const pagesTouch = (a, b) => {
      const pa = (a.pageNumbers || []).map(Number).filter(Number.isFinite);
      const pb = (b.pageNumbers || []).map(Number).filter(Number.isFinite);
      if (!pa.length || !pb.length) return true;
      return pa.some(x => pb.some(y => Math.abs(x - y) <= 1));
    };

    const exactPrefix = (small, large) => {
      const a = dataRows(small);
      const b = dataRows(large);

      // The smaller table must contain at least 2 data rows. This avoids
      // accidentally collapsing legitimate one-row catalog sections.
      if (a.length < 2 || a.length >= b.length) return false;

      for (let i = 0; i < a.length; i++) {
        const ka = canonicalRowKey(a[i]);
        const kb = canonicalRowKey(b[i]);
        if (!ka || ka !== kb) return false;
      }
      return true;
    };

    for (const table of logicalTables) {
      const prev = out[out.length - 1];

      if (
        prev &&
        pagesTouch(prev, table) &&
        exactPrefix(prev, table)
      ) {
        // The following table is the richer/canonical extraction. Preserve
        // any non-data title/subtitle rows from the first extraction, but do
        // not duplicate its data.
        const titleRows = (prev.leadingRows || []).filter(r => !isDataRow(r));

        const merged = {
          ...table,
          leadingRows: [
            ...titleRows,
            ...(table.leadingRows || [])
          ],
          pageNumbers: [
            ...new Set([
              ...(prev.pageNumbers || []),
              ...(table.pageNumbers || [])
            ])
          ],
          confidences: [
            ...(prev.confidences || []),
            ...(table.confidences || [])
          ],
          schemas: [
            ...(prev.schemas || []),
            ...(table.schemas || [])
          ],
          columnCount: Math.max(
            prev.columnCount || 0,
            table.columnCount || 0
          )
        };

        out[out.length - 1] = finalizeLogicalTable(merged);
      } else {
        out.push(table);
      }
    }

    return out;
  }

  const reconciledLogical = mergeNestedPrefixTables(logical);
  logical.length = 0;
  logical.push(...reconciledLogical);

  // LOSSLESS RECONCILIATION:
  // The Adaptive result is the canonical data source. If Catalog's structural
  // segmentation accidentally omitted any canonical row, restore that row
  // into the most appropriate logical table based on its page number.
  // This is content/multiset based, not product-name based.
  reconcileCanonicalRows(logical, canonicalRows, options);

  // Reconciliation can add only genuinely missing canonical rows, but it must
  // still pass through the same finalizer as source rows. This second pass is
  // essential when the canonical stream itself came from overlapping page
  // detection and contains repeated copies of an already-present row.
  for (let i = 0; i < logical.length; i++) {
    logical[i] = finalizeLogicalTable(logical[i]);
  }

  logical.forEach((table, index) => {
    table.name = `Table ${index + 1}`;
  });

  const confidences = logical.flatMap(table => table.confidences).filter(Number.isFinite);

  return {
    mode: "catalog",
    sheets: logical,
    header: logical[0]?.headerRows?.[0] || null,
    headerRows: logical[0]?.headerRows || [],
    rows: logical[0]?.rows || [],
    columnCount: Math.max(1, ...logical.map(t => t.columnCount || 1)),
    pageCount: pages.length,
    tableCount: logical.length,
    modes: [...new Set(pageBlocks.map(p => p.mode).filter(Boolean))],
    confidence: confidences.length ? median(confidences) : null,
    diagnostics: {
      sourceRowCount,
      physicalSourceRows: pageBlocks.reduce((sum, b) =>
        sum + b.rows.length + b.headerRows.length + b.leadingRows.length, 0),
      finalLogicalRows: logical.reduce((sum, t) => sum + (t.rows?.length || 0), 0),
      exportedRowCount: logical.reduce((sum, t) =>
        sum + (t.rows?.length || 0), 0),
      missingCanonicalDataRows: Math.max(0, sourceRowCount - logical.reduce((sum, t) =>
        sum + (t.rows?.length || 0), 0)),
      droppedRowCount: 0,
      pageBlocks: pageBlocks.map(b => ({
        page: b.pageNumber,
        schema: b.schema,
        sourceRows: b.rows.length + b.headerRows.length + b.leadingRows.length,
        rows: b.rows.length,
        headerRows: b.headerRows.length,
        leadingRows: b.leadingRows.length,
        sectionKey: b.sectionKey || ""
      }))
    }
  };
}

function normalizeRow(row, page, sourceIndex = -1) {
  return {
    ...row,
    page,
    sourceIndex,
    cells: (row.cells || []).map(cell => cell ? { ...cell, text: normalizeText(cell.text || "") } : { text: "", colspan: 1, rowspan: 1 })
  };
}


// ---------------------------------------------------------------------------
// GENERIC SECTION IDENTITY
//
// A Catalog sheet represents one logical section of the source PDF. A section
// title is detected from structure/geometry, not from vendor/product names.
// This lets WCP, MONOTARO, Prabawa, etc. keep independent sections even when
// their column schemas and numbering are identical.
// ---------------------------------------------------------------------------
function sectionIdentity(rows, columnCount) {
  if (!Array.isArray(rows) || !rows.length) return "";

  const parts = [];
  for (const row of rows) {
    const cells = nonEmptyCells(row);
    if (!cells.length || isDataRow(row)) continue;

    const raw = (row.cells || []).filter(Boolean);
    const span = raw.reduce((sum, c) => {
      const text = normalizeText(c?.text || "");
      return text ? sum + Math.max(1, Number(c?.colspan) || 1) : sum;
    }, 0);

    const text = normalizeText(rowText(row));
    const likelyTitle =
      (cells.length <= 2 && text.length >= 4) ||
      (row.bold && cells.length <= 4) ||
      (columnCount > 0 && span >= Math.max(2, Math.ceil(columnCount * 0.55)));

    if (likelyTitle) parts.push(text.toLowerCase());
  }

  return parts.join(" | ");
}

function isStrongSectionBoundary(rows, index, columnCount) {
  const row = rows[index];
  if (!row || isDataRow(row)) return false;

  const following = rows.slice(index + 1, Math.min(rows.length, index + 6));
  const title = sectionIdentity([row], columnCount);
  if (!title) return false;

  // A title followed shortly by a real table header is the strongest generic
  // signal that a new physical section starts here.
  if (following.some(r => looksLikeHeader(r, rows.slice(index + 2, index + 6)))) {
    return true;
  }

  // If the title spans most of the table width, it is still a strong boundary
  // even when OCR/layout makes the header score weak.
  const cells = (row.cells || []).filter(Boolean);
  const span = cells.reduce((sum, c) =>
    normalizeText(c?.text || "") ? sum + Math.max(1, Number(c?.colspan) || 1) : sum, 0);
  return columnCount > 0 && span >= Math.ceil(columnCount * 0.65);
}

function splitPageIntoTableBlocks(rows, page) {
  if (rows.length <= 1) return [{ rows, bbox: null }];

  const heights = rows.map(r => Math.max(1, (r.bottom || 0) - (r.top || 0)));
  const typicalHeight = median(heights);
  const blocks = [];
  let start = 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const row = rows[i];
    const gap = Math.max(0, (row.top || 0) - (prev.bottom || 0));

    const candidateHeader = looksLikeHeader(row, rows.slice(i + 1, Math.min(rows.length, i + 5)));
    const priorHasData = rows.slice(start, i).some(isDataRow);

    // Repeated header after data = new physical table on the same page.
    if (priorHasData && candidateHeader) {
      blocks.push(makeBlock(rows.slice(start, i)));
      start = i;
      continue;
    }

    // A large vertical gap followed by a title/header is another strong
    // physical-table boundary. The multiplier is relative to the PDF's own
    // row height, so it generalizes across page sizes and zoom levels.
    const nextIsTitleOrHeader = isStructuralRow(row) || candidateHeader;
    const strongSection = priorHasData && isStrongSectionBoundary(rows, i, Math.max(
      1,
      ...rows.slice(start, i + 1).map(r => (r.cells || []).length)
    ));

    if (strongSection || (priorHasData && gap > Math.max(8, typicalHeight * 2.6) && nextIsTitleOrHeader)) {
      blocks.push(makeBlock(rows.slice(start, i)));
      start = i;
    }
  }

  blocks.push(makeBlock(rows.slice(start)));
  return blocks.filter(block => block.rows.length);
}

function makeBlock(rows) {
  const allWords = rows.flatMap(r => r.words || []);
  const bbox = allWords.length ? {
    x0: Math.min(...allWords.map(w => w.x0)),
    y0: Math.min(...allWords.map(w => w.top)),
    x1: Math.max(...allWords.map(w => w.x1)),
    y1: Math.max(...allWords.map(w => w.bottom))
  } : null;
  return { rows, bbox };
}

function inferHeaderRows(rows) {
  if (!rows.length) return { count: 0, rows: [], leadingRows: [] };

  // Find the first strong header in the block. A title/category band can
  // legitimately appear immediately before it and is retained as leading row.
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    // A header may follow title/section rows, but it must never be allowed
    // to "skip over" a real data row. Doing so would silently discard those
    // rows when the body slice starts at headerIndex + headerCount.
    const prefix = rows.slice(0, i);
    const prefixHasData = prefix.some(isDataRow);
    if (prefixHasData) break;

    if (looksLikeHeader(rows[i], rows.slice(i + 1, i + 5))) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex < 0) {
    // Continuation page without a header: leave all rows as body.
    return { count: 0, rows: [], leadingRows: [] };
  }

  let count = 1;
  if (rows[headerIndex + 1] && looksLikeHeaderContinuation(rows[headerIndex + 1], rows[headerIndex])) {
    count = 2;
  }

  const headers = rows.slice(headerIndex, headerIndex + count).map(row => ({
    ...row,
    catalogRole: "header"
  }));

  // LOSSLESS RULE:
  // Every source row must survive classification. Rows before a detected
  // header are never discarded. Structural rows are marked "section";
  // ordinary rows remain "body". This prevents data-loss when a title/header
  // is detected after a valid row.
  const leadingRows = rows.slice(0, headerIndex).map(row => ({
    ...row,
    catalogRole: isStructuralRow(row) && !isDataRow(row) ? "section" : "body"
  }));

  return {
    count: headerIndex + count,
    rows: headers,
    leadingRows
  };
}

function looksLikeHeader(row, followingRows = []) {
  const text = rowText(row).toLowerCase();
  const cells = nonEmptyCells(row);
  if (!text || cells.length < 2) return false;

  let score = 0;
  const tokenHits = GENERIC_HEADER_WORDS.filter(token => new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(text)).length;
  score += Math.min(5, tokenHits * 0.9);
  if (row.bold) score += 2;
  if (cells.length >= 4) score += 1;
  if (cells.some(cell => PRICEISH.test(cell))) score -= 1;
  if (cells.every(cell => cell.length <= 28)) score += 1;

  const next = followingRows.find(r => isDataRow(r));
  if (next) {
    const numeric = nonEmptyCells(next).filter(v => looksNumeric(v)).length;
    if (numeric >= 1) score += 1.5;
    if (numeric >= 3) score += 1;
  }

  // A row with a single wide title is not a header.
  if (cells.length <= 2 && rowText(row).length < 40) score -= 1;

  return score >= 4.0;
}

function looksLikeHeaderContinuation(row, previous) {
  const text = rowText(row).toLowerCase();
  if (!text) return false;
  const cells = nonEmptyCells(row);
  if (!cells.length) return false;

  const tokenHits = GENERIC_HEADER_WORDS.filter(token => new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(text)).length;
  const mostlyShort = cells.filter(c => c.length <= 24).length / cells.length >= 0.65;
  return tokenHits >= 1 && mostlyShort && !isDataRow(row) && row.top >= previous.bottom;
}

function matchesSixColumnCatalogSchema(row) {
  const cells = nonEmptyCells(row);
  if (cells.length !== 6) return false;

  const stocked = /^(yes|no|y|n)$/i.test(cells[3]);
  if (!stocked) return false;

  const numeric = v => looksNumeric(v);
  // Product code is intentionally unrestricted: spaces, fractions and
  // hyphenated forms are legitimate codes. The remaining columns provide the
  // schema evidence that this is a product row.
  return (
    cells[0].length >= 2 &&
    numeric(cells[1]) &&
    numeric(cells[2]) &&
    numeric(cells[4]) &&
    numeric(cells[5])
  );
}

function isDataRow(row) {
  const cells = nonEmptyCells(row);
  if (!cells.length) return false;

  // Schema-level recovery for catalogs with a stable 6-column product table.
  // This runs before product-code heuristics, so codes such as "104111",
  // "1075 16-101", "131-2005-B", and "1/4 NPT" are preserved.
  if (matchesSixColumnCatalogSchema(row)) return true;
  if (!cells.length) return false;

  const rawCells = (row?.cells || []).filter(Boolean);
  const first = cells[0] || "";
  const numericCount = cells.filter(looksNumeric).length;
  const hasLeadingNo = /^\d{1,5}$/.test(first);

  // Catalog product codes are not necessarily single tokens. Real-world
  // catalogs commonly contain spaces, fractions, X separators and descriptive
  // hyphenated codes, e.g. "1/2 NPT", "1/4-20 X 3/4",
  // "10-1353 - 21178", or "1075 16-101".
  //
  // Keep the original strict code test, but add a schema-like fallback:
  // a row with a code-like first cell + at least two numeric/value-bearing
  // columns is strongly indicative of a product row. This is intentionally
  // based on row shape, not vendor/product names.
  const hasStrictCodeLike =
    /^[A-Z0-9][A-Z0-9._/-]{2,}$/.test(first) && /[A-Z]/i.test(first);
  const hasStructuredCodeLike =
    /^\d+\/\d+(?:\s|$)/.test(first) ||                 // 1/2 NPT
    /^\d+[-/]\d+\s+X\s+\d+[-/]\d+$/i.test(first) || // 1/4-20 X 3/4
    /^\d{2,6}\s*-\s*\d/.test(first) ||               // 10-1353 - 21178
    /^\d{3,6}\s+\d{1,4}[-/]\d/.test(first);           // 1075 16-101
  const hasPrice = cells.some(v => PRICEISH.test(v));
  const enoughColumns = cells.length >= 3;
  const numericEvidence = numericCount >= 2;

  // Strong, generic evidence for a body row.
  if (hasLeadingNo && enoughColumns) return true;
  if (hasStrictCodeLike && enoughColumns && (numericCount >= 1 || hasPrice)) return true;
  if (hasStructuredCodeLike && enoughColumns && (numericEvidence || hasPrice)) return true;
  if (hasPrice && cells.length >= 3 && numericCount >= 1) return true;

  // Coordinate/table-geometry evidence: when the row has a regular number
  // of cells and is surrounded by other data rows, treat it as data even if
  // one or more values are text such as "#N/A", "-", or a long description.
  const previous = row?.previousRow;
  const next = row?.nextRow;
  const neighborData = (previous && isDataRowCore(previous)) ||
                       (next && isDataRowCore(next));
  if (enoughColumns && neighborData && !looksLikePureHeaderText(row)) return true;

  // A body row can have no numeric values (e.g. a product with blank price).
  // Do not require a price/number if the first cell looks like a part/item
  // code and the row has the table's normal width.
  if ((hasStrictCodeLike || hasStructuredCodeLike) && rawCells.length >= 3) return true;

  return false;
}

function isDataRowCore(row) {
  const cells = nonEmptyCells(row);
  if (!cells.length) return false;
  if (matchesSixColumnCatalogSchema(row)) return true;
  const first = cells[0] || "";
  const numericCount = cells.filter(looksNumeric).length;
  const hasLeadingNo = /^\d{1,5}$/.test(first);
  const hasStrictCodeLike =
    /^[A-Z0-9][A-Z0-9._/-]{2,}$/.test(first) && /[A-Z]/i.test(first);
  const hasStructuredCodeLike =
    /^\d+\/\d+(?:\s|$)/.test(first) ||
    /^\d+[-/]\d+\s+X\s+\d+[-/]\d+$/i.test(first) ||
    /^\d{2,6}\s*-\s*\d/.test(first) ||
    /^\d{3,6}\s+\d{1,4}[-/]\d/.test(first);
  const hasPrice = cells.some(v => PRICEISH.test(v));
  const numericEvidence = numericCount >= 2;

  return (hasLeadingNo && cells.length >= 3) ||
         (hasStrictCodeLike && cells.length >= 3 && (numericCount >= 1 || hasPrice)) ||
         (hasStructuredCodeLike && cells.length >= 3 && (numericEvidence || hasPrice)) ||
         (hasPrice && cells.length >= 3 && numericCount >= 1);
}

function looksLikePureHeaderText(row) {
  const cells = nonEmptyCells(row);
  if (!cells.length) return true;
  const hits = cells.filter(v =>
    GENERIC_HEADER_WORDS.some(token =>
      new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(v)
    )
  ).length;
  return hits >= Math.max(2, Math.ceil(cells.length * 0.6));
}

function isStructuralRow(row) {
  const cells = nonEmptyCells(row);
  if (!cells.length) return true;
  if (isDataRow(row)) return false;
  if (cells.length <= 2) return true;
  if (row.bold && cells.length <= 3) return true;
  return false;
}

function nonEmptyCells(row) {
  return (row?.cells || []).map(c => normalizeText(c?.text || "")).filter(Boolean);
}

function looksNumeric(value) {
  const text = normalizeText(value).replace(/\s/g, "");
  if (!text) return false;
  return /^[-+]?\d+(?:[.,]\d+)*$/.test(text) || PRICEISH.test(text);
}

function firstDataSignature(rows) {
  const row = rows.find(isDataRow);
  if (!row) return "";
  return row.cells.map(c => normalizeText(c?.text || "") ? "1" : "0").join("");
}

function schemaSignature(headerRows, count) {
  if (!headerRows.length) return `cols:${count}`;
  return headerRows.map(row =>
    row.cells.map(c => normalizeText(c?.text || "").toLowerCase()).join("|")
  ).join(" / ");
}


function isTitlePrefixedDuplicate(block, current) {
  if (!current || !block) return false;
  if (!current.leadingRows?.length) return false;
  if (!block.headerRows?.length) return false;

  const a = (current.rows || []).filter(isDataRow);
  const b = (block.rows || []).filter(isDataRow);
  if (!a.length || !b.length || a.length > b.length) return false;

  // The smaller block must be an exact physical/content prefix of the larger
  // block. This is generic and avoids merging two independent sections that
  // merely happen to use the same numbering.
  for (let i = 0; i < a.length; i++) {
    const ak = canonicalRowKey(a[i]);
    const bk = canonicalRowKey(b[i]);
    if (!ak || ak !== bk) return false;
  }

  const pageA = Number(current.pageNumbers?.[current.pageNumbers.length - 1]);
  const pageB = Number(block.pageNumber);
  if (Number.isFinite(pageA) && Number.isFinite(pageB) && pageB < pageA) return false;

  return true;
}

function isContinuation(block, current, previousBlock) {
  const currentSchema = block.schema;
  const previousSchema = current.schema;
  const schemaSimilar = schemasSimilar(currentSchema, previousSchema);
  const noHeader = block.headerRows.length === 0;
  const first = block.rows.find(isDataRow);
  const firstNo = extractLeadingNumber(first);
  const lastNo = lastLeadingNumber(current.rows);

  // A structural/title-only block is not a logical table by itself. If it
  // contains no actual data and the next block is on the same/adjacent page,
  // attach it to the following table so the title keeps its Catalog styling.
  const currentDataRows = (current.rows || []).filter(isDataRow);
  const currentIsTitleOnly =
    currentDataRows.length === 0 &&
    (current.leadingRows || []).some(r => !isDataRow(r));

  const currentLastPage = Number(
    current.pageNumbers?.[current.pageNumbers.length - 1]
  );
  const blockPage = Number(block.pageNumber);
  const pageAdjacent =
    !Number.isFinite(currentLastPage) ||
    !Number.isFinite(blockPage) ||
    Math.abs(blockPage - currentLastPage) <= 1;

  if (
    currentIsTitleOnly &&
    pageAdjacent &&
    (block.headerRows.length > 0 || Number.isFinite(firstNo))
  ) {
    return true;
  }

  // Generic nested-detection case: a title-only prefix was extracted once,
  // then the same physical table was extracted again with its real column
  // header. Merge only when the smaller block is an exact data prefix of the
  // larger block. This prevents the duplicate FEPOWERTOOLS 1..23 sheet while
  // keeping unrelated sections separate.
  if (isTitlePrefixedDuplicate(block, current)) {
    return true;
  }

  // A genuine sequential continuation across adjacent pages is stronger
  // than a missing/changed sectionKey. This handles catalogs whose header is
  // detected differently on continuation pages. A new title/leading section
  // blocks this rule, preventing unrelated sections from being merged.
  const hasLeadingTitle = (block.leadingRows || []).some(r => !isDataRow(r));
  if (
    pageAdjacent &&
    Number.isFinite(firstNo) &&
    Number.isFinite(lastNo) &&
    firstNo === lastNo + 1 &&
    block.columnCount === current.columnCount &&
    !hasLeadingTitle
  ) {
    return true;
  }

  // A detected section identity is authoritative for Catalog sheet
  // boundaries. Different section identities must NEVER be merged, even when
  // column schema and item numbering happen to be identical.
  if (block.sectionKey) {
    if (!current.sectionKey) return false;
    if (block.sectionKey !== current.sectionKey) return false;
  }

  // Strongest case: continuation page has no repeated header but uses the
  // same column count/schema inherited from the previous table.
  if (noHeader && block.columnCount === current.columnCount) {
    if (Number.isFinite(firstNo) && Number.isFinite(lastNo) && firstNo >= lastNo) return true;
    if (!previousBlock) return true;
  }

  if (schemaSimilar && block.columnCount === current.columnCount) {
    if (Number.isFinite(firstNo) && Number.isFinite(lastNo) && firstNo > lastNo) return true;
    if (block.pageNumber > current.pageNumbers[current.pageNumbers.length - 1]) {
      const hasLeadingTitle = block.leadingRows.length > 0;
      if (!hasLeadingTitle) return true;
    }
  }

  if (block.columnCount === current.columnCount && block.leadingRows.length === 0) {
    const previousLast = lastDataSignature(current.rows);
    if (block.firstData && previousLast && block.firstData === previousLast) {
      return true;
    }
  }

  return false;
}

function schemasSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return textSimilarity(a.replace(/\|/g, " "), b.replace(/\|/g, " ")) >= 0.72;
}

function extractLeadingNumber(row) {
  if (!row) return NaN;
  const text = normalizeText(row.cells?.[0]?.text || "");
  const match = text.match(/^(\d{1,5})\b/);
  return match ? Number(match[1]) : NaN;
}

function lastLeadingNumber(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const n = extractLeadingNumber(rows[i]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function lastDataSignature(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isDataRow(rows[i])) return rows[i].cells.map(c => normalizeText(c?.text || "") ? "1" : "0").join("");
  }
  return "";
}

function canonicalRowKey(row) {
  return (row?.cells || [])
    .map(cell => normalizeText(cell?.text || ""))
    .join("\u001f");
}

function physicalRowKey(row) {
  const content = canonicalRowKey(row);
  if (!content) return "";

  const page = Number.isFinite(Number(row?.page)) ? Number(row.page) : "";
  const top = Number.isFinite(Number(row?.top)) ? Math.round(Number(row.top) * 10) / 10 : "";
  const bottom = Number.isFinite(Number(row?.bottom)) ? Math.round(Number(row.bottom) * 10) / 10 : "";

  // Physical coordinates are critical: identical product rows can legitimately
  // occur more than once in a catalog (different sections/pages). Only rows
  // occupying the same physical position are considered overlap duplicates.
  if (page !== "" && top !== "" && bottom !== "") {
    return `${page}\u001f${top}\u001f${bottom}\u001f${content}`;
  }

  // Fallback for synthetic rows where geometry is unavailable.
  const sourceIndex = Number.isFinite(Number(row?.sourceIndex)) ? Number(row.sourceIndex) : "";
  return `${page}\u001f${sourceIndex}\u001f${content}`;
}

function reconcileCanonicalRows(logical, canonicalRows, options = {}) {
  if (!Array.isArray(canonicalRows) || !canonicalRows.length || !logical.length) return;

  const exportedKeys = new Set();
  for (const table of logical) {
    for (const row of (table.rows || [])) {
      if (!isDataRow(row)) continue;
      const key = physicalRowKey(row);
      if (key) exportedKeys.add(key);
    }
  }

  // Canonical Adaptive rows are the source of truth for *physical occurrences*.
  // If a legitimate identical product occurs twice at different coordinates,
  // both occurrences survive. If the same physical row was already extracted
  // by an overlapping Catalog block, it is not injected a second time.
  for (const row of canonicalRows) {
    if (!isDataRow(row)) continue;

    const key = physicalRowKey(row);
    if (!key || exportedKeys.has(key)) continue;

    const page = Number(row.page);
    let target = logical.find(t => (t.pageNumbers || []).includes(page));

    if (!target && Number.isFinite(page)) {
      target = logical.reduce((best, t) => {
        const pages = t.pageNumbers || [];
        if (!pages.length) return best;
        const distance = Math.min(...pages.map(p => Math.abs(Number(p) - page)));
        if (!best || distance < best.distance) return { table: t, distance };
        return best;
      }, null)?.table;
    }

    if (!target) target = logical[logical.length - 1];

    target.rows.push({
      ...row,
      catalogRole: "body",
      cells: (row.cells || []).map(cell =>
        cell ? { ...cell, colspan: cell.colspan || 1, rowspan: cell.rowspan || 1 }
            : { text: "", colspan: 1, rowspan: 1 }
      )
    });

    exportedKeys.add(key);
  }
}

function createLogicalTable(block) {
  return {
    name: "",
    pageNumbers: [block.pageNumber],
    headerRows: cloneRows(block.headerRows),
    leadingRows: cloneRows(block.leadingRows),
    rows: cloneRows(block.rows),
    columnCount: block.columnCount,
    confidences: [block.confidence],
    schemas: [block.schema],
    sectionKey: block.sectionKey || ""
  };
}

function appendBlock(table, block) {
  if (block.headerRows.length) {
    if (!table.headerRows.length) table.headerRows = cloneRows(block.headerRows);
  }

  const existingKeys = new Set(
    (table.rows || []).filter(isDataRow).map(canonicalRowKey).filter(Boolean)
  );

  for (const row of block.leadingRows || []) {
    if (isDataRow(row)) {
      const key = canonicalRowKey(row);
      if (!key || !existingKeys.has(key)) {
        table.rows.push(cloneRows([row])[0]);
        if (key) existingKeys.add(key);
      }
    } else {
      table.leadingRows.push(cloneRows([row])[0]);
    }
  }

  for (const row of block.rows || []) {
    if (!isDataRow(row)) {
      table.rows.push(cloneRows([row])[0]);
      continue;
    }

    const key = canonicalRowKey(row);
    if (key && existingKeys.has(key)) continue;

    table.rows.push(cloneRows([row])[0]);
    if (key) existingKeys.add(key);
  }

  table.pageNumbers.push(block.pageNumber);
  table.confidences.push(block.confidence);
  table.schemas.push(block.schema);
  table.columnCount = Math.max(table.columnCount, block.columnCount);
  if (!table.sectionKey && block.sectionKey) table.sectionKey = block.sectionKey;
}

function finalizeLogicalTable(table) {
  const headerKeys = new Set(
    (table.headerRows || []).map(canonicalRowKey).filter(Boolean)
  );

  // Structural rows may repeat because of overlapping page/table discovery.
  // Dedup only when they share the same physical location.
  const leadingSeen = new Set();
  const leadingRows = [];
  for (const row of table.leadingRows || []) {
    const key = physicalRowKey(row);
    if (!key || leadingSeen.has(key)) continue;
    leadingSeen.add(key);
    leadingRows.push(row);
  }

  const seenRows = new Set();
  const rows = [];

  for (const row of table.rows || []) {
    const key = physicalRowKey(row);
    if (!key) continue;

    // A repeated header at the same physical position is structural. A row
    // with identical text at a different position is NOT automatically a
    // duplicate because real catalogs can repeat the same part.
    if (headerKeys.has(canonicalRowKey(row))) continue;

    if (seenRows.has(key)) continue;
    seenRows.add(key);
    rows.push(row);
  }

  // Preserve the exact physical order from the PDF. Rows may be exported
  // to different sheets, but within each sheet they must remain monotonic by
  // page -> vertical position -> source index.
  rows.sort((a, b) => {
    const pa = Number.isFinite(Number(a?.page)) ? Number(a.page) : Infinity;
    const pb = Number.isFinite(Number(b?.page)) ? Number(b.page) : Infinity;
    if (pa !== pb) return pa - pb;

    const ta = Number.isFinite(Number(a?.top)) ? Number(a.top) : Infinity;
    const tb = Number.isFinite(Number(b?.top)) ? Number(b.top) : Infinity;
    if (ta !== tb) return ta - tb;

    const ia = Number.isFinite(Number(a?.sourceIndex)) ? Number(a.sourceIndex) : Infinity;
    const ib = Number.isFinite(Number(b?.sourceIndex)) ? Number(b.sourceIndex) : Infinity;
    return ia - ib;
  });

  const columnCount = Math.max(
    table.columnCount || 1,
    ...(table.headerRows || []).map(r => r.cells.length),
    ...leadingRows.map(r => r.cells.length),
    ...rows.map(r => r.cells.length)
  );

  for (const row of [...(table.headerRows || []), ...leadingRows, ...rows]) {
    padRow(row, columnCount);
  }

  return {
    ...table,
    columnCount,
    pageNumbers: [...new Set(table.pageNumbers || [])],
    headerRows: table.headerRows || [],
    leadingRows,
    rows
  };
}

function rowText(row) {
  return (row?.cells || []).map(cell => normalizeText(cell?.text || "")).join(" | ");
}

function cloneRows(rows) {
  return rows.map(row => ({
    ...row,
    cells: (row.cells || []).map(cell => cell ? { ...cell } : { text: "", colspan: 1, rowspan: 1 }),
    words: row.words ? [...row.words] : []
  }));
}

function padRow(row, size) {
  while (row.cells.length < size) row.cells.push({ text: "", colspan: 1, rowspan: 1 });
  row.cells.length = size;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
