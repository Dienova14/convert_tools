/* =========================================================
   grouped.js — parser untuk price list dengan rowspan/continuation

   Cocok untuk layout seperti:
   No. | Size | Spec/Grit | Rp.
   32  | 305 X ... | 38A - 46 LVBE | 2,628,210.-
       |           | 38A - 60 LVBE | 2,628,210.-
       |           | 38A - 80 LVBE | 2,628,210.-

   Prinsip:
   - satu physical text line yang memiliki harga = satu data row;
   - No dan Size di-forward-fill ketika PDF memakai rowspan visual;
   - state No/Size dapat berlanjut ke halaman berikutnya;
   - header/footer/judul tidak menjadi row karena tidak memiliki pola harga.
   ========================================================= */

import { clusterTextLines } from "./table.js";
import { normalizeText, overlap } from "./geometry.js";

const PRICE_RE = /(?:Rp\.?\s*)?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{2})?\.-?/;
const NO_RE = /^\d{1,4}$/;
const SIZE_RE = /^\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?(?:\s*[xX]\s*\d+(?:[.,]\d+)?){1,3}(?:\s*\/\s*\d+(?:[.,]\d+)?)?$/;

export function buildGroupedPage(pageContent) {
  const lines = clusterTextLines(pageContent.words);
  const header = findHeader(lines);
  if (!header) return { mode: "grouped", header: null, rows: [] };

  const anchors = getAnchors(header);
  if (!anchors) return { mode: "grouped", header: null, rows: [] };

  const rows = [];
  const dataStart = header.bottom;

  for (const line of lines) {
    if (line.top <= dataStart + 2) continue;

    const cells = assignGroupedLine(line.words, anchors);
    const price = cells[3]?.text || "";
    if (!PRICE_RE.test(price)) continue;

    rows.push({
      cells: cells.map((cell, index) => ({
        text: normalizeText(cell?.text || ""),
        colspan: 1,
        rowspan: 1,
        ...(index === 0 && cell?.text ? { groupStart: true } : {})
      })),
      top: line.top,
      bottom: line.bottom,
      page: pageContent.pageNumber
    });
  }

  const headerLabel = anchors.thirdLabel === "Grit" ? "Grit" : "Spec.";

  return {
    mode: "grouped",
    header: {
      cells: [
        { text: "No.", colspan: 1, rowspan: 1 },
        { text: "Size", colspan: 1, rowspan: 1 },
        { text: headerLabel, colspan: 1, rowspan: 1 },
        { text: "Rp.", colspan: 1, rowspan: 1 }
      ],
      bold: true,
      fontSize: header.bottom - header.top
    },
    rows,
    anchors
  };
}

function findHeader(lines) {
  return lines.find(line => {
    const text = normalizeText(line.words.map(word => word.text).join(" ")).toLowerCase();
    return text.includes("no.") && text.includes("rp.") && (text.includes("spec.") || text.includes("grit"));
  }) || null;
}

function getAnchors(header) {
  const words = header.words;
  const no = words.find(w => /^no\.?$/i.test(w.text));
  const third = words.find(w => /^(spec\.?|grit)$/i.test(w.text));
  const rp = words.find(w => /^rp\.?$/i.test(w.text));
  if (!no || !third || !rp) return null;

  const size = words.find(w => /^size$/i.test(w.text));

  const noX = center(no);
  const sizeX = size ? center(size) : (noX + center(third)) / 2;
  const thirdX = center(third);
  const priceX = center(rp);

  if (!(noX < sizeX && sizeX < thirdX && thirdX < priceX)) return null;

  return {
    noX,
    sizeX,
    thirdX,
    priceX,
    thirdLabel: /^grit$/i.test(third.text) ? "Grit" : "Spec."
  };
}

function center(word) {
  return (word.x0 + word.x1) / 2;
}

function assignGroupedLine(words, anchors) {
  const centers = [anchors.noX, anchors.sizeX, anchors.thirdX, anchors.priceX];
  const buckets = [[], [], [], []];

  for (const word of words) {
    // Header/metadata di kiri atas halaman tidak ikut karena buildGroupedPage
    // hanya memanggil fungsi ini untuk baris yang mengandung price.
    const cx = center(word);
    let nearest = 0;
    let best = Infinity;
    centers.forEach((anchor, index) => {
      const distance = Math.abs(cx - anchor);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    buckets[nearest].push(word);
  }

  return buckets.map(parts => ({ text: joinParts(parts) }));
}

function joinParts(parts) {
  const sorted = [...parts].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  let text = "";
  let previous = null;

  for (const part of sorted) {
    if (!previous) {
      text = part.text;
    } else {
      const sameLine = overlap(previous.top, previous.bottom, part.top, part.bottom) > 0;
      const gap = part.x0 - previous.x1;
      const glue = sameLine && gap < Math.max(1, previous.fontSize || 8) * 0.22 ? "" : " ";
      text += glue + part.text;
    }
    previous = part;
  }

  return normalizeText(text);
}

export function isGroupedRow(row) {
  return Boolean(row?.cells?.[3]?.text && PRICE_RE.test(row.cells[3].text));
}

export function isNoValue(value) {
  return NO_RE.test(normalizeText(value));
}

export function isSizeValue(value) {
  return SIZE_RE.test(normalizeText(value));
}
