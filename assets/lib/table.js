/* =========================================================
   table.js — menentukan struktur tabel dari satu halaman
   ========================================================= */

import {
  boundariesToRanges,
  cluster1D,
  median,
  normalizeText,
  overlap
} from "./geometry.js";

import { hasHorizontalLine, hasVerticalLine } from "./rulings.js";
import { typicalFontSize } from "./page-content.js";

/* ---------------------------------------------------------
   Pengelompokan kata menjadi baris teks
   --------------------------------------------------------- */

export function clusterTextLines(words) {
  const sorted = [...words]
    .filter(w => !w.vertical)
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);

  const lines = [];

  for (const word of sorted) {
    const wordHeight = Math.max(1, word.bottom - word.top);
    const wordCenterY = (word.top + word.bottom) / 2;
    let target = null;

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const line = lines[i];
      const lineHeight = Math.max(1, line.bottom - line.top);
      const lineCenterY = (line.top + line.bottom) / 2;
      const shared = overlap(line.top, line.bottom, word.top, word.bottom);
      const minHeight = Math.min(lineHeight, wordHeight) || 1;
      const avgHeight = (lineHeight + wordHeight) / 2;

      // Evaluasi overlap vertikal DAN jarak titik tengah (Center-Y).
      // Ini mencegah kata di baris berikutnya tersedot ketika spasi vertikal rapat.
      const hasOverlap = shared / minHeight >= 0.45;
      const tightCenterY = Math.abs(wordCenterY - lineCenterY) <= avgHeight * 0.38;

      if (hasOverlap && tightCenterY) {
        target = line;
        break;
      }
    }

    if (target) {
      target.words.push(word);
      // Batasi pemuaian bounding box agar tidak menjalar ke baris berikutnya
      target.top = Math.min(target.top, word.top);
      target.bottom = Math.max(target.bottom, word.bottom);
    } else {
      lines.push({ top: word.top, bottom: word.bottom, words: [word] });
    }
  }

  for (const line of lines) line.words.sort((a, b) => a.x0 - b.x0);
  lines.sort((a, b) => a.top - b.top);

  return lines;
}

/* ---------------------------------------------------------
   Deteksi kolom dari celah kosong (tanpa border)
   --------------------------------------------------------- */

export function detectColumnBoundaries(lines, options = {}) {
  const usable = lines.filter(line => line.words.length);
  if (usable.length < 2) return null;

  const words = usable.flatMap(line => line.words);
  if (words.length < 4) return null;

  const left = Math.min(...words.map(w => w.x0));
  const right = Math.max(...words.map(w => w.x1));
  const width = right - left;
  if (width <= 0) return null;

  const fontSize = typicalFontSize(words);
  const minGutter = options.minGutter ?? Math.max(3.5, fontSize * 0.55);

  const bodyLines = usable.filter(line => {
    if (line.words.length > 1) return true;
    const span = line.words[0].x1 - line.words[0].x0;
    return span < width * 0.8;
  });

  const reference = bodyLines.length >= 2 ? bodyLines : usable;

  const bins = Math.max(8, Math.ceil(width));
  const counts = new Float32Array(bins + 1);
  const scale = bins / width;

  for (const line of reference) {
    const marked = new Uint8Array(bins + 1);

    for (const word of line.words) {
      const pad = Math.min(1.5, fontSize * 0.12);
      const a = Math.max(0, Math.floor((word.x0 - pad - left) * scale));
      const b = Math.min(bins, Math.ceil((word.x1 + pad - left) * scale));
      for (let i = a; i <= b; i++) marked[i] = 1;
    }

    for (let i = 0; i <= bins; i++) counts[i] += marked[i];
  }

  const tolerance = options.gutterTolerance ?? 0.03;
  const maxCrossing = Math.floor(reference.length * tolerance);

  const gutters = [];
  let start = null;

  for (let i = 0; i <= bins; i++) {
    const isGap = counts[i] <= maxCrossing;

    if (isGap && start === null) start = i;

    if (!isGap && start !== null) {
      gutters.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) gutters.push([start, bins]);

  const boundaries = [];

  for (const [a, b] of gutters) {
    const x0 = left + a / scale;
    const x1 = left + b / scale;

    if (x0 <= left + 0.5 || x1 >= right - 0.5) continue;
    if (x1 - x0 < minGutter) continue;

    boundaries.push((x0 + x1) / 2);
  }

  if (!boundaries.length) return null;

  return [left - 1, ...boundaries, right + 1];
}

/* ---------------------------------------------------------
   Penempatan kata ke dalam sel
   --------------------------------------------------------- */

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
      const glue = sameLine && gap < previous.fontSize * 0.08 ? "" : " ";
      text += glue + part.text;
    }
    previous = part;
  }

  return normalizeText(text);
}

export function assignToColumns(words, columns) {
  const cells = columns.map(() => ({ parts: [], colspan: 1 }));

  for (const word of words) {
    const wordWidth = Math.max(0.5, word.x1 - word.x0);

    // Dinaikkan ke 42% agar teks yang menyentuh batas kolom tidak langsung memicu merge kolom horizontal
    const hits = columns
      .map((column, index) => ({ index, shared: overlap(column.x0, column.x1, word.x0, word.x1) }))
      .filter(hit => hit.shared >= wordWidth * 0.42);

    if (!hits.length) {
      const center = (word.x0 + word.x1) / 2;
      let nearest = 0;
      let best = Infinity;

      columns.forEach((column, index) => {
        const distance = Math.abs((column.x0 + column.x1) / 2 - center);
        if (distance < best) {
          best = distance;
          nearest = index;
        }
      });

      cells[nearest].parts.push(word);
      continue;
    }

    const first = hits[0].index;
    const last = hits[hits.length - 1].index;

    cells[first].parts.push(word);
    cells[first].colspan = Math.max(cells[first].colspan, last - first + 1);
  }

  return cells.map(cell => ({
    text: joinParts(cell.parts),
    colspan: cell.colspan,
    rowspan: 1
  }));
}

/* ---------------------------------------------------------
   Adaptive column detection helpers
   --------------------------------------------------------- */

const ADAPTIVE_MAX_COLUMNS = 12;
const ADAPTIVE_MAX_CANDIDATES = 12;

function adaptiveNumericLike(value) {
  const text = normalizeText(value);
  if (!text || /^[+-]?0\d+$/.test(text)) return false;
  return /^(?:rp\.?\s*|idr\s*|usd\s*|\$\s*)?[+-]?[\d.,]+\s*%?$/i.test(text);
}

function clusterPositions(values, tolerance = 4) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];

  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last.max <= tolerance) {
      last.values.push(value);
      last.max = value;
    } else {
      clusters.push({ values: [value], min: value, max: value });
    }
  }

  return clusters.map(cluster => ({
    value: median(cluster.values),
    count: cluster.values.length,
    min: cluster.min,
    max: cluster.max
  }));
}

function adaptiveCandidates(lines, left, right, fontSize) {
  const byLine = [];
  const gapPositions = [];
  const gapWidths = [];
  const edgePositions = [];

  for (const line of lines) {
    const words = [...line.words].sort((a, b) => a.x0 - b.x0);
    const gaps = [];

    for (let i = 1; i < words.length; i++) {
      const previous = words[i - 1];
      const current = words[i];
      const gap = current.x0 - previous.x1;
      if (gap < Math.max(2, fontSize * 0.35)) continue;

      const center = (previous.x1 + current.x0) / 2;
      if (center <= left + 2 || center >= right - 2) continue;

      gaps.push({ center, gap });
      gapPositions.push(center);
      gapWidths.push(gap);
    }

    byLine.push(gaps);
    for (const word of words) {
      if (word.x0 > left + 2 && word.x0 < right - 2) edgePositions.push(word.x0);
      if (word.x1 > left + 2 && word.x1 < right - 2) edgePositions.push(word.x1);
    }
  }

  const candidates = [];
  const clusters = clusterPositions(gapPositions, Math.max(3, fontSize * 0.35));

  for (const cluster of clusters) {
    const support = byLine.filter(gaps =>
      gaps.some(gap => Math.abs(gap.center - cluster.value) <= Math.max(3, fontSize * 0.35))
    ).length / Math.max(1, lines.length);

    const nearbyGaps = gapPositions
      .map((position, index) => ({ position, width: gapWidths[index] }))
      .filter(item => Math.abs(item.position - cluster.value) <= Math.max(3, fontSize * 0.35));

    const averageGap = nearbyGaps.length
      ? nearbyGaps.reduce((sum, item) => sum + item.width, 0) / nearbyGaps.length
      : 0;

    candidates.push({
      x: cluster.value,
      support,
      gap: averageGap,
      source: "gap"
    });
  }

  for (const cluster of clusterPositions(edgePositions, Math.max(3, fontSize * 0.45))) {
    const support = Math.min(1, cluster.count / Math.max(2, lines.length));
    if (support < 0.12) continue;
    candidates.push({
      x: cluster.value,
      support: support * 0.65,
      gap: 0,
      source: "edge"
    });
  }

  const merged = clusterPositions(candidates.map(item => item.x), Math.max(4, fontSize * 0.45));
  const normalized = merged.map(cluster => {
    const nearby = candidates.filter(item => Math.abs(item.x - cluster.value) <= Math.max(4, fontSize * 0.45));
    const best = nearby.sort((a, b) =>
      (b.support + Math.min(0.25, b.gap / Math.max(1, fontSize * 8))) -
      (a.support + Math.min(0.25, a.gap / Math.max(1, fontSize * 8)))
    )[0];
    return {
      x: cluster.value,
      support: Math.max(...nearby.map(item => item.support), best?.support || 0),
      gap: Math.max(...nearby.map(item => item.gap), best?.gap || 0),
      source: best?.source || "edge"
    };
  });

  return normalized
    .filter(item => item.x > left + Math.max(3, fontSize) && item.x < right - Math.max(3, fontSize))
    .sort((a, b) => (b.support - a.support) || (b.gap - a.gap))
    .slice(0, ADAPTIVE_MAX_CANDIDATES);
}

function adaptiveBoundaryPenalty(lines, boundaries) {
  let cuts = 0;
  let opportunities = 0;

  for (const line of lines) {
    for (const boundary of boundaries) {
      const word = line.words.find(item => item.x0 + 1 < boundary && item.x1 - 1 > boundary);
      if (word) cuts++;
      opportunities++;
    }
  }

  return opportunities ? cuts / opportunities : 0;
}

function scoreAdaptiveColumns(lines, columns, candidateMap) {
  if (columns.length < 2 || columns.length > ADAPTIVE_MAX_COLUMNS) return -Infinity;

  const firstLine = lines[0];
  const firstLineWords = firstLine?.words?.length || 0;
  const headerColumnHint = firstLineWords >= 2 && firstLineWords <= 6 ? firstLineWords : null;

  const rows = lines.map(line => {
    const cells = columns.map(() => []);
    for (const word of line.words) {
      const center = (word.x0 + word.x1) / 2;
      let index = columns.findIndex(column => center >= column.x0 && center < column.x1);
      if (index < 0) index = center >= columns[columns.length - 1].x0 ? columns.length - 1 : 0;
      cells[index].push(word);
    }
    return cells;
  });

  const nonEmptyByColumn = columns.map((_, index) =>
    rows.filter(cells => cells[index].length > 0).length / Math.max(1, rows.length)
  );

  const occupiedRatio = nonEmptyByColumn.filter(value => value >= 0.15).length / columns.length;
  if (occupiedRatio < 0.5) return -Infinity;

  const widths = columns.map(column => column.x1 - column.x0);
  if (widths.some(width => width < 6)) return -Infinity;

  const emptyPenalty = nonEmptyByColumn.filter(value => value < 0.15).length / columns.length;
  const widePenalty = Math.min(1, Math.max(...widths) / Math.max(1, Math.min(...widths)) / 12);

  let numericConsistency = 0;
  for (let c = 0; c < columns.length; c++) {
    const values = rows
      .map(cells => normalizeText(cells[c].map(word => word.text).join(" ")))
      .filter(Boolean);
    if (values.length < 2) continue;
    const numericRatio = values.filter(adaptiveNumericLike).length / values.length;
    if (numericRatio >= 0.65 || numericRatio <= 0.15) numericConsistency += 1;
  }
  numericConsistency /= columns.length;

  const boundarySupport = candidateMap.reduce((sum, candidate) => sum + candidate.support, 0) /
    Math.max(1, candidateMap.length);

  const cutPenalty = adaptiveBoundaryPenalty(lines, columns.slice(0, -1).map(column => column.x1));

  const columnCountPenalty = columns.length > 6 ? (columns.length - 6) * 0.08 : 0;
  const columnCountFit = headerColumnHint
    ? Math.max(0, 1 - Math.abs(columns.length - headerColumnHint) / Math.max(2, headerColumnHint))
    : Math.min(1, columns.length / 4);

  return (
    occupiedRatio * 0.24 +
    numericConsistency * 0.22 +
    boundarySupport * 0.20 +
    columnCountFit * 0.18 +
    (1 - emptyPenalty) * 0.10 -
    widePenalty * 0.04 -
    cutPenalty * 0.45 -
    columnCountPenalty
  );
}

function chooseAdaptiveColumns(lines, candidates, left, right, fontSize) {
  if (!candidates.length) return null;

  const top = candidates.slice(0, Math.min(10, candidates.length));
  const minDistance = Math.max(10, fontSize * 1.8);
  let best = null;
  const limit = 1 << top.length;

  for (let mask = 1; mask < limit; mask++) {
    const selected = [];
    for (let i = 0; i < top.length; i++) {
      if (mask & (1 << i)) selected.push(top[i]);
    }

    if (selected.length > ADAPTIVE_MAX_COLUMNS - 1) continue;
    selected.sort((a, b) => a.x - b.x);

    let valid = true;
    for (let i = 1; i < selected.length; i++) {
      if (selected[i].x - selected[i - 1].x < minDistance) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    const boundaries = selected.map(item => item.x);
    const columns = boundariesToRanges([left - 1, ...boundaries, right + 1]);
    const score = scoreAdaptiveColumns(lines, columns, selected);
    if (!Number.isFinite(score)) continue;

    const candidate = { columns, boundaries, score, candidates: selected };
    if (!best || score > best.score) best = candidate;
  }

  if (!best) return null;

  const confidence = Math.max(0, Math.min(1, best.score));
  return { ...best, confidence };
}

export function detectAdaptiveColumns(lines, options = {}) {
  const usable = lines.filter(line => line.words.length);
  if (usable.length < 2) return null;

  const words = usable.flatMap(line => line.words);
  if (words.length < 4) return null;

  const left = Math.min(...words.map(word => word.x0));
  const right = Math.max(...words.map(word => word.x1));
  if (!(right > left)) return null;

  const fontSize = typicalFontSize(words);
  const candidates = adaptiveCandidates(usable, left, right, fontSize);
  const result = chooseAdaptiveColumns(usable, candidates, left, right, fontSize);

  if (!result) return null;

  const minimumConfidence = options.adaptiveMinConfidence ?? 0.42;
  if (result.confidence < minimumConfidence) return null;

  return result;
}

/* ---------------------------------------------------------
   Header detection & row-gap recovery
   --------------------------------------------------------- */

function headerWordScore(word) {
  const text = String(word?.text || "").trim();
  if (!text) return 0;

  const letters = (text.match(/[\p{L}]/gu) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  const length = text.length;
  const font = Number(word?.fontSize) || 0;
  const bold = /bold|semibold|demi/i.test(String(word?.fontFamily || ""));

  let score = 0;
  if (letters > 0) score += 1.1;
  if (digits > 0 && letters === 0) score += 0.35;
  if (length <= 35) score += 0.55;
  if (length > 70) score -= 0.8;
  if (digits >= 4 && letters === 0) score -= 0.8;
  if (bold) score += 1.0;
  if (font >= 11) score += 0.15;

  return score;
}

function headerLineScore(line, pageWidth) {
  const words = line?.words || [];
  if (words.length < 3) return -Infinity;

  const groups = groupHeaderWords(words, Math.max(6, typicalFontSize(words) * 1.25));
  if (groups.length < 3 || groups.length > 14) return -Infinity;

  const x0 = Math.min(...words.map(w => w.x0));
  const x1 = Math.max(...words.map(w => w.x1));
  const span = x1 - x0;
  if (span < pageWidth * 0.30) return -Infinity;

  const text = normalizeText(words.map(w => w.text).join(" "));
  const numericWords = words.filter(w => numericLikeForLayout(w.text)).length;
  const numericRatio = numericWords / Math.max(1, words.length);
  const boldRatio = words.filter(w => /bold|semibold|demi/i.test(String(w.fontFamily || ""))).length / words.length;
  const avgLen = words.reduce((sum, w) => sum + String(w.text || "").length, 0) / words.length;

  let score = 0;
  score += Math.min(4, groups.length * 0.55);
  score += Math.min(3, (span / Math.max(1, pageWidth)) * 4);
  score += words.reduce((sum, w) => sum + headerWordScore(w), 0) / words.length;
  score += boldRatio * 2.5;

  if (numericRatio > 0.75 && boldRatio < 0.25) score -= 2.5;
  if (avgLen > 40) score -= 1.0;
  if (groups.length <= 2 && text.length > 30) score -= 3;

  return score;
}

function groupHeaderWords(words, gap = 8) {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  const groups = [];
  for (const word of sorted) {
    if (!groups.length || word.x0 - groups[groups.length - 1].x1 > gap) {
      groups.push({ x0: word.x0, x1: word.x1, words: [word] });
    } else {
      const g = groups[groups.length - 1];
      g.x1 = Math.max(g.x1, word.x1);
      g.words.push(word);
    }
  }
  return groups;
}

function detectHeaderGroups(pageContent) {
  const words = pageContent.words || [];
  if (words.length < 6) return null;

  const height = pageContent.height || 842;
  const width = pageContent.width || 595;
  const topWords = words.filter(w => w.top < height * 0.45);
  if (topWords.length < 6) return null;

  const lines = clusterTextLines(topWords);
  let best = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const scoreBase = headerLineScore(line, width);
    if (!Number.isFinite(scoreBase)) continue;

    const groups = groupHeaderWords(
      line.words,
      Math.max(6, typicalFontSize(line.words) * 1.25)
    );

    const next = lines.slice(index + 1, Math.min(lines.length, index + 6));
    let continuationFit = 0;
    let dataEvidence = 0;

    for (const candidate of next) {
      if (candidate.top <= line.bottom + 2) continue;
      const candidateSpan = Math.max(...candidate.words.map(w => w.x1)) - Math.min(...candidate.words.map(w => w.x0));
      if (candidateSpan < width * 0.35) continue;

      const centers = groups.map(g => (g.x0 + g.x1) / 2);
      const matched = centers.filter(center =>
        candidate.words.some(w => center >= w.x0 - 6 && center <= w.x1 + 6)
      ).length;

      const fit = matched / Math.max(1, groups.length);
      continuationFit = Math.max(continuationFit, fit);

      const dataLike = candidate.words.filter(w => numericLikeForLayout(w.text)).length;
      if (dataLike >= 1 || candidate.words.length >= groups.length) dataEvidence += 1;
    }

    let score = scoreBase;
    score += continuationFit * 4.0;
    score += Math.min(2.0, dataEvidence * 0.6);
    score -= index * 0.22;

    const candidateNumeric = line.words.filter(w => numericLikeForLayout(w.text));
    const candidateNumericRatio = candidateNumeric.length / Math.max(1, line.words.length);
    const candidateHasPriceLike = candidateNumeric.some(w =>
      String(w.text || "").replace(/\s+/g, "").match(/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/)
    );
    const candidateBoldRatio = line.words.filter(w =>
      /bold|semibold|demi|black|heavy/i.test(String(w.fontFamily || ""))
    ).length / Math.max(1, line.words.length);

    if (candidateHasPriceLike) score -= 5.0;
    else if (candidateNumericRatio >= 0.15 && candidateBoldRatio < 0.35) score -= 3.0;

    if (candidateNumeric.length === 0 && groups.length >= 4) score += 3.0;

    if (candidateNumeric.length === 0 && next[0] && continuationFit >= 0.6) {
      score += 1.5;
    }

    if (continuationFit < 0.45 && dataEvidence === 0) score -= 2;

    if (!best || score > best.score) {
      best = {
        groups,
        score,
        y0: Math.min(...line.words.map(w => w.top)),
        y1: Math.max(...line.words.map(w => w.bottom))
      };
    }
  }

  return best && best.score >= 7.0 ? best : null;
}

function numericLikeForLayout(text) {
  const t = String(text || "").trim().replace(/\s+/g, "");
  if (!t) return false;
  return /^(?:[A-Za-z]?\d+(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)$/.test(t);
}

function detectFirstDataBand(pageContent, header) {
  const words = pageContent.words || [];
  if (!header) return null;

  const width = pageContent.width || 595;
  const expectedColumns = header.groups.length;
  const after = words.filter(w => w.top > header.y1 + 3 && w.top < (pageContent.height || 842) * 0.90);
  if (after.length < 4) return null;

  const lines = clusterTextLines(after);
  const headerCenters = header.groups.map(g => (g.x0 + g.x1) / 2);

  let best = null;

  for (const line of lines.slice(0, 12)) {
    if (line.words.length < Math.max(3, Math.min(expectedColumns, 4))) continue;

    const span = Math.max(...line.words.map(w => w.x1)) - Math.min(...line.words.map(w => w.x0));
    if (span < width * 0.45) continue;

    const matched = headerCenters.filter(center =>
      line.words.some(w => center >= w.x0 - 10 && center <= w.x1 + 10)
    ).length;
    const fit = matched / Math.max(1, expectedColumns);
    const numericCount = line.words.filter(w => numericLikeForLayout(w.text)).length;

    let score = fit * 5 + Math.min(2, line.words.length / expectedColumns);
    if (numericCount >= 1) score += 0.8;
    if (numericCount >= 3) score += 0.8;
    score -= Math.max(0, line.top - header.y1) * 0.002;

    if (!best || score > best.score) best = { line, score };
  }

  if (!best || best.score < 4.0) return null;

  const rowWords = best.line.words;
  return {
    top: best.line.top,
    bottom: best.line.bottom,
    words: rowWords,
    y: (best.line.top + best.line.bottom) / 2
  };
}

function detectRowGapRecovery(pageContent, options = {}) {
  const header = detectHeaderGroups(pageContent);
  if (!header) return null;

  const expectedColumns = header.groups.length;
  if (expectedColumns < 3 || expectedColumns > 14) return null;

  const first = detectFirstDataBand(pageContent, header);
  if (!first) return null;

  const spans = first.words
    .map(w => ({ x0: w.x0, x1: w.x1, text: w.text }))
    .sort((a, b) => a.x0 - b.x0);

  const merged = [];
  for (const span of spans) {
    if (!merged.length || span.x0 > merged[merged.length - 1].x1 + 1.5) {
      merged.push({ x0: span.x0, x1: span.x1 });
    } else {
      merged[merged.length - 1].x1 = Math.max(merged[merged.length - 1].x1, span.x1);
    }
  }

  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].x0 - merged[i - 1].x1;
    if (gap >= Math.max(6, typicalFontSize(first.words) * 0.7)) gaps.push({ gap, x: (merged[i - 1].x1 + merged[i].x0) / 2 });
  }

  if (gaps.length < expectedColumns - 1) return null;

  const selected = gaps
    .sort((a, b) => b.gap - a.gap)
    .slice(0, expectedColumns - 1)
    .sort((a, b) => a.x - b.x);

  const left = Math.min(...header.groups.map(g => g.x0), ...first.words.map(w => w.x0));
  const right = Math.max(...header.groups.map(g => g.x1), ...first.words.map(w => w.x1));
  const columnLines = [left, ...selected.map(g => g.x), right];

  const headerCenters = header.groups.map(g => (g.x0 + g.x1) / 2);
  let headerFit = 0;
  for (let i = 1; i < columnLines.length - 1; i++) {
    const boundary = columnLines[i];
    const a = headerCenters[i - 1];
    const b = headerCenters[i];
    if (boundary > a && boundary < b) headerFit++;
  }

  const fitRatio = headerFit / Math.max(1, columnLines.length - 2);
  if (fitRatio < 0.75) return null;

  const columns = boundariesToRanges(columnLines);
  const confidence = Math.min(0.97, 0.68 + fitRatio * 0.18 + Math.min(0.12, (selected.reduce((s, g) => s + g.gap, 0) / selected.length) / 120));

  return {
    columns,
    columnLines,
    rowSeparators: null,
    firstDataBand: first,
    header,
    confidence
  };
}

function inferOcrAnchorColumns(pageContent, visualGrid) {
  const words = (pageContent.words || []).filter(word => !word.vertical);
  if (words.length < 6) return null;

  const horizontal = (visualGrid?.horizontal || [])
    .map(line => Number(line.y))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const x0 = horizontal.length >= 2
    ? Math.min(...(visualGrid.horizontal || []).map(line => Number(line.x0)).filter(Number.isFinite))
    : Math.min(...words.map(w => w.x0));

  const x1 = horizontal.length >= 2
    ? Math.max(...(visualGrid.horizontal || []).map(line => Number(line.x1)).filter(Number.isFinite))
    : Math.max(...words.map(w => w.x1));

  if (!(x1 > x0)) return null;

  const font = typicalFontSize(words);
  const tableTop = horizontal.length >= 2 ? horizontal[0] : Math.min(...words.map(w => w.top));
  const tableBottom = horizontal.length >= 2 ? horizontal[horizontal.length - 1] : Math.max(...words.map(w => w.bottom));

  const body = words.filter(word => {
    const cy = (word.top + word.bottom) / 2;
    const conf = Number(word.confidence);
    return cy > tableTop + Math.max(8, font) &&
      cy < tableBottom - Math.max(5, font * 0.5) &&
      (!Number.isFinite(conf) || conf >= 20);
  });

  if (body.length < 6) return null;

  const lines = clusterTextLines(body);
  if (lines.length < 3) return null;

  const bins = Math.max(120, Math.min(900, Math.ceil(x1 - x0)));
  const coverage = new Float32Array(bins + 1);
  const scale = bins / (x1 - x0);

  for (const line of lines) {
    const marked = new Uint8Array(bins + 1);
    const lineWords = [...line.words].sort((a, b) => a.x0 - b.x0);

    for (const word of lineWords) {
      const conf = Number(word.confidence);
      if (Number.isFinite(conf) && conf < 20) continue;

      const a = Math.max(0, Math.floor((word.x0 - x0) * scale));
      const b = Math.min(bins, Math.ceil((word.x1 - x0) * scale));
      for (let i = a; i <= b; i++) marked[i] = 1;
    }

    for (let i = 0; i <= bins; i++) coverage[i] += marked[i];
  }

  const threshold = Math.max(2, Math.ceil(lines.length * 0.22));
  const runs = [];
  let start = null;

  for (let i = 0; i <= bins; i++) {
    const on = coverage[i] >= threshold;
    if (on && start === null) start = i;
    if (!on && start !== null) {
      runs.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, bins]);

  const minBand = Math.max(10, font * 1.6);
  const bands = runs
    .map(([a, b]) => ({
      x0: x0 + a / scale,
      x1: x0 + b / scale
    }))
    .filter(band => band.x1 - band.x0 >= minBand);

  const merged = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && band.x0 - last.x1 <= Math.max(12, font * 1.8)) {
      last.x1 = Math.max(last.x1, band.x1);
    } else {
      merged.push({ ...band });
    }
  }

  if (merged.length < 2 || merged.length > 12) return null;

  const internalBoundaries = [];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i].x0 - merged[i - 1].x1;
    if (gap < Math.max(8, font * 0.7)) return null;
    internalBoundaries.push((merged[i - 1].x1 + merged[i].x0) / 2);
  }

  const internalWidths = [];
  for (let i = 1; i < internalBoundaries.length; i++) {
    internalWidths.push(internalBoundaries[i] - internalBoundaries[i - 1]);
  }
  const typicalColumnWidth = internalWidths.length
    ? median(internalWidths)
    : Math.max(20, (x1 - x0) / Math.max(2, merged.length + 1));

  const leftGap = merged[0].x0 - x0;
  const rightGap = x1 - merged[merged.length - 1].x1;

  let boundaries = [...internalBoundaries];
  let leadingEmpty = false;
  let trailingEmpty = false;

  if (leftGap > typicalColumnWidth * 0.55 && leftGap > rightGap * 1.5) {
    leadingEmpty = true;
    const firstBoundary = internalBoundaries.length
      ? internalBoundaries[0] - typicalColumnWidth
      : merged[0].x0 - Math.min(leftGap, typicalColumnWidth);
    boundaries.unshift(Math.max(x0 + 2, firstBoundary));
  }

  if (rightGap > typicalColumnWidth * 0.55 && rightGap > leftGap * 1.5) {
    trailingEmpty = true;
    const lastBoundary = internalBoundaries.length
      ? internalBoundaries[internalBoundaries.length - 1] + typicalColumnWidth
      : merged[merged.length - 1].x1 + Math.min(rightGap, typicalColumnWidth);
    boundaries.push(Math.min(x1 - 2, lastBoundary));
  }

  boundaries = cluster1D(boundaries, Math.max(3, font * 0.35));
  const columnLines = [x0, ...boundaries.filter(x => x > x0 + 2 && x < x1 - 2), x1];

  if (columnLines.length < 3 || columnLines.length > 15) return null;

  const columns = boundariesToRanges(columnLines);
  let assigned = 0;
  for (const word of body) {
    const cx = (word.x0 + word.x1) / 2;
    if (columns.some(column => cx >= column.x0 && cx <= column.x1)) assigned++;
  }

  const assignmentRatio = assigned / Math.max(1, body.length);
  if (assignmentRatio < 0.82) return null;

  return {
    columns,
    columnLines,
    rowSeparators: horizontal.length >= 3 ? horizontal : null,
    anchorBands: merged,
    leadingEmpty,
    trailingEmpty,
    confidence: Math.min(0.96, 0.62 + assignmentRatio * 0.25 + (horizontal.length >= 4 ? 0.08 : 0))
  };
}

function detectHorizontalRowRecovery(pageContent, fontSize) {
  const horizontal = (pageContent.rulings?.horizontal || [])
    .filter(line => Number.isFinite(line.y) && Number.isFinite(line.x0) && Number.isFinite(line.x1))
    .filter(line => line.x1 - line.x0 >= Math.max(40, fontSize * 4));

  if (horizontal.length < 5) return null;

  const levels = cluster1D(horizontal.map(line => line.y), Math.max(2.5, fontSize * 0.25));
  if (levels.length < 5) return null;

  const left = Math.min(...horizontal.map(line => line.x0));
  const right = Math.max(...horizontal.map(line => line.x1));
  const width = right - left;
  if (!(width > 0)) return null;

  const coverage = levels.map(y => {
    let covered = 0;
    for (const line of horizontal) {
      if (Math.abs(line.y - y) > Math.max(2.5, fontSize * 0.25)) continue;
      covered = Math.max(covered, Math.max(0, Math.min(line.x1, right) - Math.max(line.x0, left)));
    }
    return covered / width;
  });

  const strong = coverage.filter(v => v >= 0.78).length / Math.max(1, coverage.length);
  if (strong < 0.70) return null;

  const gaps = [];
  for (let i = 1; i < levels.length; i++) {
    const gap = levels[i] - levels[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  const typical = median(gaps);
  if (!(typical > 0)) return null;

  const regular = gaps.filter(g => g >= typical * 0.45 && g <= typical * 1.8).length / Math.max(1, gaps.length);
  if (regular < 0.65) return null;

  return {
    rowSeparators: levels,
    bbox: { left, right, top: levels[0], bottom: levels[levels.length - 1] },
    confidence: Math.min(0.98, 0.72 + strong * 0.16 + regular * 0.10)
  };
}

/* ---------------------------------------------------------
   Analisis layout satu halaman
   --------------------------------------------------------- */

export function analyzePage(pageContent, options = {}) {
  const lines = clusterTextLines(pageContent.words);

  if (!lines.length) {
    return { mode: "none", lines, columns: null, rowSeparators: null, confidence: 0 };
  }

  const forced = options.mode && options.mode !== "auto" ? options.mode : null;
  const fontSize = typicalFontSize(pageContent.words);

  if (pageContent.ocr && forced === "adaptive") {
    const visualColumns = (pageContent.visualGrid?.columnLines || []).filter(Number.isFinite);
    const visualRows = (pageContent.visualGrid?.rowLines || []).filter(Number.isFinite);

    if (visualColumns.length >= 4 && visualRows.length >= 4) {
      const columns = boundariesToRanges(visualColumns);
      const rowSeparators = visualRows;

      return {
        mode: "lattice",
        lines,
        columns,
        rowSeparators,
        grid: {
          columnLines: visualColumns,
          rowLines: rowSeparators,
          columns,
          confidence: Math.min(0.99, Number(pageContent.visualGridConfidence) || 0.86)
        },
        confidence: Math.min(0.99, Number(pageContent.visualGridConfidence) || 0.86),
        adaptive: {
          source: "ocr-visual-grid",
          columns,
          columnLines: visualColumns,
          rowSeparators,
          visualGrid: pageContent.visualGrid
        }
      };
    }

    const ocrLayout = inferOcrAnchorColumns(pageContent, {
      horizontal: pageContent.rulings?.horizontal || [],
      vertical: pageContent.rulings?.vertical || []
    });

    if (ocrLayout) {
      return {
        mode: "ocr-adaptive-grid",
        lines,
        columns: ocrLayout.columns,
        rowSeparators: ocrLayout.rowSeparators,
        grid: {
          columnLines: ocrLayout.columnLines,
          rowLines: ocrLayout.rowSeparators || [],
          columns: ocrLayout.columns,
          confidence: ocrLayout.confidence
        },
        confidence: ocrLayout.confidence,
        adaptive: ocrLayout
      };
    }
  }

  const grid = forced === "stream" ? null : findGrid(pageContent, fontSize);
  const rulingGrid = forced === "stream" ? null : findVerticalGrid(pageContent, fontSize);

  let verticalGrid = grid || rulingGrid;
  if (grid && rulingGrid) {
    const moreColumns = rulingGrid.columnLines.length > grid.columnLines.length;
    const similarConfidence = rulingGrid.confidence >= (grid.confidence || 0) - 0.12;
    if (moreColumns && similarConfidence) verticalGrid = rulingGrid;
  }

  if (verticalGrid && (forced === "lattice" || !forced) && verticalGrid.columnLines.length >= 3 && verticalGrid.rowLines.length >= 3) {
    return {
      mode: "lattice",
      lines,
      columns: boundariesToRanges(verticalGrid.columnLines),
      rowSeparators: verticalGrid.rowLines,
      grid: verticalGrid,
      confidence: verticalGrid.confidence
    };
  }

  const boundaries = detectColumnBoundaries(lines, options);
  const adaptive = detectAdaptiveColumns(lines, options);
  const rowGap = detectRowGapRecovery(pageContent, options);
  const horizontalRows = detectHorizontalRowRecovery(pageContent, fontSize);

  const rowGapPreferred = rowGap && (
    !adaptive ||
    rowGap.columns.length > adaptive.columns.length + 1 ||
    rowGap.confidence > adaptive.confidence + 0.05
  );

  if (forced === "adaptive") {
    if (verticalGrid && verticalGrid.columnLines.length >= 3 && verticalGrid.rowLines.length >= 3 && verticalGrid.confidence >= 0.55) {
      return {
        mode: "adaptive-lattice",
        lines,
        columns: boundariesToRanges(verticalGrid.columnLines),
        rowSeparators: verticalGrid.rowLines,
        grid: verticalGrid,
        confidence: verticalGrid.confidence,
        adaptive: adaptive || null
      };
    }

    if (verticalGrid && verticalGrid.columnLines.length >= 3 && verticalGrid.confidence >= 0.55) {
      return {
        mode: "ruling-stream",
        lines,
        columns: verticalGrid.columns,
        rowSeparators: null,
        grid: verticalGrid,
        confidence: verticalGrid.confidence,
        adaptive: adaptive || null
      };
    }

    if (horizontalRows) {
      const horizontalColumns = rowGap?.columns || adaptive?.columns || (boundaries ? boundariesToRanges(boundaries) : null);
      if (horizontalColumns?.length >= 2) {
        return {
          mode: "adaptive-horizontal",
          lines,
          columns: horizontalColumns,
          rowSeparators: horizontalRows.rowSeparators,
          confidence: Math.max(horizontalRows.confidence, rowGap?.confidence || 0, adaptive?.confidence || 0),
          grid: horizontalRows,
          adaptive: rowGap || adaptive || null
        };
      }
    }

    if (rowGapPreferred) {
      return {
        mode: "adaptive-rowgap",
        lines,
        columns: rowGap.columns,
        rowSeparators: null,
        confidence: rowGap.confidence,
        adaptive: rowGap
      };
    }

    if (adaptive) {
      return {
        mode: "adaptive",
        lines,
        columns: adaptive.columns,
        rowSeparators: null,
        confidence: adaptive.confidence,
        adaptive
      };
    }

    return { mode: "none", lines, columns: null, rowSeparators: null, confidence: 0 };
  }

  if (verticalGrid && verticalGrid.rowLines.length >= 3 && forced !== "stream") {
    const hybridColumns = verticalGrid.columns?.length
      ? verticalGrid.columns
      : (boundaries ? boundariesToRanges(boundaries) : adaptive?.columns);

    if (hybridColumns?.length) {
      return {
        mode: "hybrid",
        lines,
        columns: hybridColumns,
        rowSeparators: verticalGrid.rowLines,
        grid: verticalGrid,
        confidence: Math.max(verticalGrid.confidence || 0, adaptive?.confidence || 0)
      };
    }
  }

  if (boundaries) {
    if (rowGapPreferred) {
      return {
        mode: "adaptive-rowgap",
        lines,
        columns: rowGap.columns,
        rowSeparators: null,
        confidence: rowGap.confidence,
        adaptive: rowGap
      };
    }

    const streamColumns = boundariesToRanges(boundaries);
    const streamConfidence = scoreAdaptiveColumns(lines, streamColumns, []);

    if (adaptive && adaptive.confidence > streamConfidence + 0.08) {
      return {
        mode: "adaptive",
        lines,
        columns: adaptive.columns,
        rowSeparators: null,
        confidence: adaptive.confidence,
        adaptive
      };
    }

    return {
      mode: "stream",
      lines,
      columns: streamColumns,
      rowSeparators: null,
      confidence: Math.max(0, Math.min(1, streamConfidence)),
      adaptive: adaptive || null
    };
  }

  if (rowGapPreferred) {
    return {
      mode: "adaptive-rowgap",
      lines,
      columns: rowGap.columns,
      rowSeparators: null,
      confidence: rowGap.confidence,
      adaptive: rowGap
    };
  }

  return { mode: "none", lines, columns: null, rowSeparators: null, confidence: 0 };
}

function findVerticalGrid(pageContent, fontSize) {
  const { rulings, words } = pageContent;
  const vertical = rulings?.vertical || [];
  if (vertical.length < 3 || words.length < 6) return null;

  const textLeft = Math.min(...words.map(w => w.x0));
  const textRight = Math.max(...words.map(w => w.x1));
  if (!(textRight > textLeft)) return null;

  const horizontal = (rulings?.horizontal || [])
    .filter(line => line.x1 - line.x0 >= Math.max(20, fontSize * 1.5));

  let left = textLeft - 2;
  let right = textRight + 2;
  let top = Math.min(...words.map(w => w.top));
  let bottom = Math.max(...words.map(w => w.bottom));

  if (horizontal.length >= 2) {
    left = Math.min(...horizontal.map(l => l.x0));
    right = Math.max(...horizontal.map(l => l.x1));
    top = Math.min(...horizontal.map(l => l.y));
    bottom = Math.max(...horizontal.map(l => l.y));
  }

  const height = Math.max(1, bottom - top);
  const levels = cluster1D(vertical.map(line => line.x), Math.max(3, fontSize * 0.28));
  const candidates = [];

  for (const x of levels) {
    const segments = vertical
      .filter(line => Math.abs(line.x - x) <= Math.max(3, fontSize * 0.28))
      .map(line => ({
        y0: Math.max(top, Math.min(bottom, line.y0)),
        y1: Math.min(bottom, Math.max(top, line.y1))
      }))
      .filter(seg => seg.y1 > seg.y0)
      .sort((a, b) => a.y0 - b.y0);

    let covered = 0;
    let current = null;
    for (const seg of segments) {
      if (!current) {
        current = { ...seg };
        continue;
      }
      if (seg.y0 <= current.y1 + 5) {
        current.y1 = Math.max(current.y1, seg.y1);
      } else {
        covered += current.y1 - current.y0;
        current = { ...seg };
      }
    }
    if (current) covered += current.y1 - current.y0;

    const coverage = covered / height;
    if (coverage >= 0.28) candidates.push({ x, coverage });
  }

  if (candidates.length < 3) return null;

  const columnLines = cluster1D(candidates.map(c => c.x), Math.max(3, fontSize * 0.28));
  if (columnLines.length < 3) return null;

  const bounded = columnLines.filter(x => x >= left - 6 && x <= right + 6);
  if (bounded.length < 3) return null;

  const columns = boundariesToRanges(bounded);
  const hits = columns.map(() => 0);
  let inside = 0;
  for (const word of words) {
    const cx = (word.x0 + word.x1) / 2;
    const cy = (word.top + word.bottom) / 2;
    if (cx < bounded[0] - 3 || cx > bounded[bounded.length - 1] + 3 || cy < top - 3 || cy > bottom + 3) continue;
    inside++;
    const index = columns.findIndex(c => cx >= c.x0 - 1 && cx <= c.x1 + 1);
    if (index >= 0) hits[index]++;
  }

  const occupancy = hits.filter(Boolean).length / columns.length;
  if (inside / Math.max(1, words.length) < 0.35 || occupancy < 0.55) return null;

  return {
    columnLines: bounded,
    columns,
    rowLines: horizontal.length >= 3 ? cluster1D(horizontal.map(l => l.y), 3) : [],
    bbox: { left: bounded[0], right: bounded[bounded.length - 1], top, bottom },
    confidence: Math.min(1, occupancy * 0.7 + candidates.reduce((s, c) => s + c.coverage, 0) / candidates.length * 0.3)
  };
}

function findGrid(pageContent, fontSize) {
  const { rulings, words } = pageContent;
  if (!rulings.horizontal.length && !rulings.vertical.length) return null;

  const minVertical = fontSize * 1.2;
  const minHorizontal = fontSize * 2;

  const horizontalCandidates = rulings.horizontal.filter(
    line => line.x1 - line.x0 >= minHorizontal
  );
  if (horizontalCandidates.length < 3) return null;

  const rowLines = cluster1D(horizontalCandidates.map(l => l.y), 3);
  if (rowLines.length < 3) return null;

  const top = rowLines[0];
  const bottom = rowLines[rowLines.length - 1];
  const tableHeight = Math.max(1, bottom - top);

  const left = Math.min(...horizontalCandidates.map(l => l.x0));
  const right = Math.max(...horizontalCandidates.map(l => l.x1));

  const rawVertical = rulings.vertical.filter(line =>
    line.y1 - line.y0 >= minVertical &&
    line.x >= left - 4 &&
    line.x <= right + 4
  );

  const verticalLevels = cluster1D(rawVertical.map(line => line.x), 3);
  const verticalCandidates = [];

  for (const x of verticalLevels) {
    const segments = rawVertical
      .filter(line => Math.abs(line.x - x) <= 3)
      .map(line => ({
        y0: Math.max(top, Math.min(bottom, line.y0)),
        y1: Math.min(bottom, Math.max(top, line.y1))
      }))
      .filter(segment => segment.y1 > segment.y0)
      .sort((a, b) => a.y0 - b.y0);

    let covered = 0;
    let current = null;

    for (const segment of segments) {
      if (!current) {
        current = { ...segment };
        continue;
      }

      if (segment.y0 <= current.y1 + 4) {
        current.y1 = Math.max(current.y1, segment.y1);
      } else {
        covered += current.y1 - current.y0;
        current = { ...segment };
      }
    }

    if (current) covered += current.y1 - current.y0;

    const coverage = covered / tableHeight;
    if (coverage >= 0.45) {
      verticalCandidates.push({ x, coverage });
    }
  }

  const columnLines = cluster1D(verticalCandidates.map(l => l.x), 3);
  if (columnLines.length < 3) return null;

  const finalLeft = columnLines[0];
  const finalRight = columnLines[columnLines.length - 1];
  if (finalRight - finalLeft < Math.max(20, fontSize * 5)) return null;

  const columns = boundariesToRanges(columnLines);
  const columnHits = new Array(columns.length).fill(0);
  let inside = 0;

  for (const word of words) {
    const cx = (word.x0 + word.x1) / 2;
    const cy = (word.top + word.bottom) / 2;
    if (
      cx < finalLeft - 2 ||
      cx > finalRight + 2 ||
      cy < top - 2 ||
      cy > bottom + 2
    ) {
      continue;
    }

    inside++;
    const index = columns.findIndex(
      column => cx >= column.x0 - 1 && cx <= column.x1 + 1
    );
    if (index >= 0) columnHits[index]++;
  }

  if (words.length && inside / words.length < 0.45) return null;

  const occupiedColumns = columnHits.filter(count => count > 0).length;
  const occupancyRatio = occupiedColumns / columns.length;

  if (columns.length >= 3 && occupancyRatio < 0.5) return null;

  const relevantRows = rowLines.filter(y => y >= top - 3 && y <= bottom + 3);
  if (relevantRows.length < 3) return null;

  return {
    columnLines,
    rowLines: relevantRows,
    bbox: { left: finalLeft, right: finalRight, top, bottom },
    confidence: occupancyRatio
  };
}

/* ---------------------------------------------------------
   Membangun baris tabel
   --------------------------------------------------------- */

export function detectNumericRowAnchors(pageContent, columns = null, header = null) {
  const words = pageContent.words || [];
  const width = pageContent.width || 595;
  if (!words.length) return [];

  const lines = clusterTextLines(words);
  const headerCenters = (header?.groups || []).map(g => (g.x0 + g.x1) / 2);

  const rowInfo = lines.map(line => {
    const numeric = line.words.filter(w => numericLikeForLayout(w.text));
    const right = Math.max(...line.words.map(w => w.x1));
    const cells = columns?.length ? assignToColumns(line.words, columns) : [];
    const populated = cells.filter(cell => cell?.text).length;
    const firstFilled = !!cells[0]?.text;
    const aligned = headerCenters.length
      ? headerCenters.filter(center =>
          line.words.some(w => center >= w.x0 - 10 && center <= w.x1 + 10)
        ).length
      : populated;

    return {
      y: (line.top + line.bottom) / 2,
      top: line.top,
      bottom: line.bottom,
      words: line.words,
      numericCount: numeric.length,
      right,
      populated,
      firstFilled,
      aligned,
      cells
    };
  });

  const headerBottom = header?.y1 ?? null;
  const bodyRows = headerBottom != null
    ? rowInfo.filter(row => row.y > headerBottom + 0.75)
    : rowInfo;

  const candidates = bodyRows.filter(row =>
    (
      row.numericCount >= 3 &&
      row.right >= width * 0.62 &&
      (!columns?.length || row.aligned >= Math.min(2, columns.length - 1))
    ) ||
    (
      columns?.length &&
      row.firstFilled &&
      row.numericCount >= 2 &&
      row.populated >= Math.min(3, columns.length) &&
      row.aligned >= Math.min(3, columns.length)
    )
  );

  for (const row of bodyRows) {
    const strong = candidates.includes(row);
    if (strong) continue;

    const weak =
      (row.firstFilled && (row.numericCount >= 1 || row.populated >= 2)) ||
      (row.populated >= 2 && row.aligned >= 2);

    if (weak) {
      candidates.push({ ...row, weak: true });
    }
  }

  candidates.sort((a, b) => a.y - b.y);

  const anchorGaps = [];
  for (let i = 1; i < candidates.length; i++) {
    const gap = candidates[i].y - candidates[i - 1].y;
    if (gap > 0) anchorGaps.push(gap);
  }
  const typicalAnchorGap = median(anchorGaps.filter(g => g >= 0));
  const font = typicalFontSize(words);
  const lastStrongIndex = candidates.reduce(
    (index, row, i) => (!row.weak ? i : index),
    -1
  );

  // Dilonggarkan agar baris terakhir tabel tidak terpotong sebagai footer
  if (lastStrongIndex >= 0 && Number.isFinite(typicalAnchorGap) && typicalAnchorGap > 0) {
    const lastStrong = candidates[lastStrongIndex];
    const cutoff = bodyRows.find(row => {
      if (row.y <= lastStrong.y + Math.max(4, font * 0.6)) return false;
      const gap = row.y - lastStrong.y;
      if (gap < Math.max(font * 3.2, typicalAnchorGap * 3.0, 18)) return false;

      const firstText = normalizeText(row.cells?.[0]?.text || "");
      const codeLike = /^[A-Z]{0,6}\d[A-Z0-9._\/-]{2,}$/i.test(firstText) ||
        /^[+-]?0\d/.test(firstText);
      const alignmentThreshold = Math.max(
        2,
        Math.ceil((headerCenters.length || columns?.length || 3) * 0.5)
      );

      const lowFit =
        row.aligned < alignmentThreshold &&
        (!row.firstFilled || !codeLike);

      const sparseFooterBlock =
        !codeLike &&
        row.populated <= Math.max(2, Math.ceil((columns?.length || 4) * 0.35)) &&
        row.numericCount <= 2;

      return lowFit || sparseFooterBlock;
    });

    if (cutoff) {
      return candidates.filter(row => row.y < cutoff.top);
    }
  }

  const merged = [];
  for (const a of candidates) {
    const prev = merged[merged.length - 1];
    if (prev && a.y - prev.y <= 3) {
      prev.y = (prev.y + a.y) / 2;
      prev.numericCount = Math.max(prev.numericCount, a.numericCount);
      prev.weak = prev.weak && a.weak;
      prev.words.push(...a.words);
    } else {
      merged.push({ ...a });
    }
  }
  return merged;
}

function buildPriceListPhysicalRows(pageContent, columns, header) {
  if (!columns?.length || !header) return null;
  const words = pageContent.words || [];
  if (words.length < 12) return null;

  const lines = clusterTextLines(words);
  const headerBottom = header.y1;
  const body = lines.filter(line => line.top > headerBottom + 1.5);
  if (body.length < 2) return null;

  const rightColumn = columns[columns.length - 1];
  const firstHeader = normalizeText(header.groups?.[0]?.words?.map(w => w.text).join(" ") || "");
  const firstHeaderWord = firstHeader.split(/\s+/)[0] || "";

  const info = body.map(line => {
    const cells = assignToColumns(line.words, columns);
    const populated = cells.filter(c => c?.text).length;
    const numeric = line.words.filter(w => numericLikeForLayout(w.text));
    const rightHit = line.words.some(w => {
      const cx = (w.x0 + w.x1) / 2;
      return cx >= rightColumn.x0 - 5 && cx <= rightColumn.x1 + 5;
    });
    const span = Math.max(...line.words.map(w => w.x1)) - Math.min(...line.words.map(w => w.x0));
    const firstText = normalizeText(cells[0]?.text || "");
    const startsLikeProduct = firstHeaderWord
      ? firstText.split(/\s+/)[0] === firstHeaderWord
      : populated >= Math.min(3, columns.length);
    const priceLike = numeric.some(w =>
      /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/.test(String(w.text || "").replace(/\s+/g, ""))
    );
    return { line, cells, populated, numericCount: numeric.length, rightHit, span, startsLikeProduct, priceLike };
  });

  const candidates = info.filter(x =>
    x.startsLikeProduct && x.populated >= Math.min(3, columns.length) &&
    x.rightHit && x.priceLike && x.span >= (pageContent.width || 595) * 0.45
  );
  if (candidates.length < 2) return null;

  const first = candidates[0];
  if (first.line.top - headerBottom > Math.max(45, typicalFontSize(words) * 8)) return null;

  const rows = candidates.map(item =>
    makeRow(item.cells, item.line.top, item.line.bottom, item.line.words)
  );

  rows.sort((a, b) => a.top - b.top);
  return rows.filter((row, i) => i === 0 || row.top - rows[i - 1].top > 1.5);
}

function buildAdaptiveRowGapRows(pageContent, layout) {
  const header = layout.adaptive?.header || detectHeaderGroups(pageContent);
  const priceListRows = buildPriceListPhysicalRows(pageContent, layout.columns, header);
  if (priceListRows && priceListRows.length >= 2) return priceListRows;

  const anchors = detectNumericRowAnchors(
    pageContent,
    layout.columns,
    header
  );
  if (anchors.length < 1) return buildStreamRows(pageContent, layout, { joinWrapped: true });

  const headerBottom = layout.adaptive?.header?.y1 ?? Math.max(0, anchors[0].y - 25);
  const rows = [];

  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i].y;
    const previous = i > 0 ? anchors[i - 1].y : null;
    const next = i + 1 < anchors.length ? anchors[i + 1].y : null;

    let top;
    if (previous == null) {
      top = Math.max(headerBottom + 1, current - 24);
    } else {
      top = (previous + current) / 2;
    }

    let bottom;
    if (next == null) {
      bottom = Math.min(pageContent.height, current + 24);
    } else {
      bottom = (current + next) / 2;
    }

    const words = pageContent.words.filter(word => {
      const cy = (word.top + word.bottom) / 2;
      return cy >= top && cy < bottom;
    });

    if (!words.length) continue;

    const cells = assignToColumns(words, layout.columns);
    if (!cells.some(cell => cell.text)) continue;

    rows.push(makeRow(cells, top, bottom, words));
  }

  return rows;
}

export function buildRows(pageContent, layout, options = {}) {
  if (layout.mode === "none" || !layout.columns) return [];

  if (layout.mode === "lattice" || layout.mode === "adaptive-lattice") {
    return buildLatticeRows(pageContent, layout);
  }

  if (layout.mode === "hybrid" || layout.mode === "ocr-adaptive-grid" || layout.mode === "adaptive-horizontal") {
    return buildBandedRows(pageContent, layout);
  }

  if (layout.mode === "adaptive-rowgap") {
    return buildAdaptiveRowGapRows(pageContent, layout);
  }

  if (layout.mode === "ruling-stream") {
    return buildStreamRows(pageContent, layout, options);
  }

  return buildStreamRows(pageContent, layout, options);
}

/** Grid penuh: baris & kolom dari garis, merge cell dari garis yang hilang. */
function buildLatticeRows(pageContent, layout) {
  const { grid, columns } = layout;
  const { rulings } = pageContent;

  const rowLines = grid.rowLines;
  const columnLines = grid.columnLines;

  const bands = [];
  for (let i = 0; i < rowLines.length - 1; i++) {
    const base = { top: rowLines[i], bottom: rowLines[i + 1] };
    const words = pageContent.words.filter(word => {
      const cx = (word.x0 + word.x1) / 2;
      const cy = (word.top + word.bottom) / 2;
      const wordHeight = Math.max(1, word.bottom - word.top);
      const vOverlap = Math.max(0, Math.min(word.bottom, base.bottom + 1.5) - Math.max(word.top, base.top - 1.5));

      // Toleransi vertikal diperlebar agar teks yang mepet garis border atas/bawah tidak terbuang
      return (
        cx >= columnLines[0] - 2 &&
        cx <= columnLines[columnLines.length - 1] + 2 &&
        ((vOverlap / wordHeight) >= 0.40 || (cy >= base.top - 1.5 && cy <= base.bottom + 1.5))
      );
    });

    const split = splitBandByStructuralRows(
      words,
      base,
      columns,
      detectHeaderGroups(pageContent)
    );
    bands.push(...split);
  }

  const taken = bands.map(() => new Array(columns.length).fill(false));
  const rows = [];

  for (let r = 0; r < bands.length; r++) {
    const band = bands[r];
    const cells = new Array(columns.length).fill(null);

    for (let c = 0; c < columns.length; c++) {
      if (taken[r][c]) continue;

      let colspan = 1;
      while (
        c + colspan < columns.length &&
        !hasVerticalLine(rulings, columnLines[c + colspan], band.top + 1, band.bottom - 1)
      ) {
        colspan++;
      }

      const spanLeft = columns[c].x0;
      const spanRight = columns[c + colspan - 1].x1;

      let rowspan = 1;
      while (r + rowspan < bands.length) {
        const separatorY = rowLines[r + rowspan];
        if (hasHorizontalLine(rulings, separatorY, spanLeft + 1, spanRight - 1, 3.5, 0.45)) {
          break;
        }

        const nextBand = bands[r + rowspan];
        const hasTextInSpan = pageContent.words.some(word => {
          const cx = (word.x0 + word.x1) / 2;
          const cy = (word.top + word.bottom) / 2;
          return (
            cx >= spanLeft - 1 &&
            cx <= spanRight + 1 &&
            cy >= nextBand.top &&
            cy <= nextBand.bottom
          );
        });

        if (hasTextInSpan) break;
        rowspan++;
      }

      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          taken[r + dr][c + dc] = true;
        }
      }

      const spanTop = band.top;
      const spanBottom = bands[r + rowspan - 1].bottom;

      // Filter teks per sel dengan toleransi overlap vertikal
      const parts = pageContent.words.filter(word => {
        const cx = (word.x0 + word.x1) / 2;
        const cy = (word.top + word.bottom) / 2;
        const wordHeight = Math.max(1, word.bottom - word.top);
        const vOverlap = Math.max(0, Math.min(word.bottom, spanBottom + 1.5) - Math.max(word.top, spanTop - 1.5));

        return (
          cx >= spanLeft - 1 &&
          cx <= spanRight + 1 &&
          ((vOverlap / wordHeight) >= 0.40 || (cy >= spanTop - 1.5 && cy <= spanBottom + 1.5))
        );
      });

      cells[c] = { text: joinParts(parts), colspan, rowspan, parts };
    }

    rows.push(makeRow(cells, band.top, band.bottom));
  }

  return rows.filter(row => row.cells.some(cell => cell && cell.text));
}

function splitBandByStructuralRows(words, band, columns, header = null) {
  if (!words.length || columns.length < 2) return [band];

  const lines = clusterTextLines(words);
  if (lines.length < 2) return [band];

  const centers = columns.map(column => (column.x0 + column.x1) / 2);
  const rightColumn = columns[columns.length - 1];
  const font = typicalFontSize(words);
  const headerTop = header?.y0 ?? null;
  const headerBottom = header?.y1 ?? null;

  const lineInfo = lines.map(line => {
    const cells = assignToColumns(line.words, columns);
    const populated = cells.filter(cell => cell?.text).length;
    const numericCount = line.words.filter(word => numericLikeForLayout(word.text)).length;
    const rightHit = line.words.some(word => {
      const cx = (word.x0 + word.x1) / 2;
      return cx >= rightColumn.x0 - 3 && cx <= rightColumn.x1 + 3;
    });
    const aligned = centers.filter(center =>
      line.words.some(word => center >= word.x0 - 8 && center <= word.x1 + 8)
    ).length;
    const cy = (line.top + line.bottom) / 2;
    const isHeader = headerTop != null && headerBottom != null &&
      line.top < headerBottom + 2 && line.bottom > headerTop - 2;

    const firstText = normalizeText(cells[0]?.text || "");
    const codeLike = /^[A-Z]{0,6}\d[A-Z0-9._\/-]{2,}$/i.test(firstText) ||
      /^[+-]?0\d/.test(firstText);

    // Kriteria baris mandiri tanpa harus selalu bergantung pada angka
    const dataLike = !isHeader && (
      (rightHit && numericCount >= 1 && populated >= Math.min(3, columns.length)) ||
      (populated >= Math.max(3, Math.ceil(columns.length * 0.55)) && aligned >= Math.min(3, columns.length)) ||
      (codeLike && populated >= Math.min(2, columns.length) && aligned >= 2) ||
      (populated >= 2 && line.words.length >= 2 && aligned >= 2)
    );

    return {
      line,
      top: line.top,
      bottom: line.bottom,
      cy,
      cells,
      populated,
      numericCount,
      rightHit,
      aligned,
      isHeader,
      dataLike
    };
  });

  const data = lineInfo.filter(item => item.dataLike).sort((a, b) => a.cy - b.cy);
  const headerLine = lineInfo.find(item => item.isHeader);

  if (data.length < 2 && !headerLine) return [band];

  const result = [];
  const orderedData = data;
  const cutGap = Math.max(2, font * 0.35);

  if (headerLine) {
    const firstData = orderedData[0];
    if (firstData && firstData.cy > headerLine.cy) {
      const cut = (headerLine.cy + firstData.cy) / 2;
      if (cut > band.top + 1 && cut < band.bottom - 1) {
        result.push({ top: band.top, bottom: cut, _structural: "header" });
        const dataTop = cut;
        for (let i = 0; i < orderedData.length; i++) {
          const current = orderedData[i];
          const previous = i > 0 ? orderedData[i - 1] : null;
          const top = previous ? (previous.cy + current.cy) / 2 : dataTop;
          const next = orderedData[i + 1];
          const bottom = next ? (current.cy + next.cy) / 2 : band.bottom;
          if (bottom - top > cutGap) result.push({ top, bottom, _structural: "data" });
        }
        return result.length >= 2 ? result : [band];
      }
    }
  }

  if (orderedData.length >= 2) {
    for (let i = 0; i < orderedData.length; i++) {
      const current = orderedData[i];
      const previous = orderedData[i - 1];
      const next = orderedData[i + 1];
      const top = previous ? (previous.cy + current.cy) / 2 : band.top;
      const bottom = next ? (current.cy + next.cy) / 2 : band.bottom;
      if (bottom - top > cutGap) result.push({ top, bottom, _structural: "data" });
    }
    if (result.length >= 2) return result;
  }

  return [band];
}

export function splitLatticeBandByDataLines(words, band, columns) {
  if (!words.length || columns.length < 2) return [band];

  const lines = clusterTextLines(words);
  if (lines.length < 2) return [band];

  const centers = columns.map(column => (column.x0 + column.x1) / 2);
  const rightColumn = columns[columns.length - 1];
  const font = typicalFontSize(words);

  const candidates = lines.filter(line => {
    const cells = assignToColumns(line.words, columns);
    const populated = cells.filter(cell => cell?.text).length;
    const numericCount = line.words.filter(word => numericLikeForLayout(word.text)).length;
    const rightHit = line.words.some(word => {
      const cx = (word.x0 + word.x1) / 2;
      return cx >= rightColumn.x0 - 3 && cx <= rightColumn.x1 + 3;
    });
    const aligned = centers.filter(center =>
      line.words.some(word => center >= word.x0 - 8 && center <= word.x1 + 8)
    ).length;

    const dataLike =
      (rightHit && numericCount >= 1 && populated >= Math.min(3, columns.length)) ||
      (rightHit && populated >= Math.max(3, Math.ceil(columns.length * 0.55)) && aligned >= 3) ||
      (populated >= 2 && aligned >= 2);

    return dataLike;
  });

  if (candidates.length < 2) return [band];

  const minGap = Math.max(3, font * 0.55);
  const ordered = candidates
    .map(line => ({ line, y: (line.top + line.bottom) / 2 }))
    .sort((a, b) => a.y - b.y);

  const distinct = [];
  for (const item of ordered) {
    const prev = distinct[distinct.length - 1];
    if (prev && item.y - prev.y < minGap) {
      continue;
    }
    distinct.push(item);
  }

  if (distinct.length < 2) return [band];

  const cuts = distinct.slice(0, -1).map((item, index) =>
    (item.y + distinct[index + 1].y) / 2
  );

  const result = [];
  let top = band.top;
  for (const cut of cuts) {
    if (cut <= top + 1 || cut >= band.bottom - 1) continue;
    result.push({ top, bottom: cut });
    top = cut;
  }
  if (band.bottom > top + 1) result.push({ top, bottom: band.bottom });

  return result.length >= 2 ? result : [band];
}

function buildBandedRows(pageContent, layout) {
  const separators = layout.rowSeparators;
  const rows = [];

  for (let i = 0; i < separators.length - 1; i++) {
    const top = separators[i];
    const bottom = separators[i + 1];

    const words = pageContent.words.filter(word => {
      const cy = (word.top + word.bottom) / 2;
      return cy > top && cy < bottom;
    });

    if (!words.length) continue;

    const band = { top, bottom };
    const splitBands = splitBandByStructuralRows(
      words,
      band,
      layout.columns,
      layout.adaptive?.header || detectHeaderGroups(pageContent)
    );

    for (const splitBand of splitBands) {
      const splitWords = words.filter(word => {
        const cy = (word.top + word.bottom) / 2;
        return cy > splitBand.top && cy < splitBand.bottom;
      });
      if (!splitWords.length) continue;
      rows.push(makeRow(
        assignToColumns(splitWords, layout.columns),
        splitBand.top,
        splitBand.bottom,
        splitWords
      ));
    }
  }

  return rows;
}

function trimOutsideTableLines(lines, columns, header = null) {
  if (!lines?.length || !columns?.length) return lines;

  const headerCenters = (header?.groups || []).map(g => (g.x0 + g.x1) / 2);
  const ordered = [...lines].sort((a, b) => a.top - b.top);
  const gaps = [];

  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].top - ordered[i - 1].bottom;
    if (gap >= 0) gaps.push(gap);
  }

  const typicalGap = median(gaps);
  if (!Number.isFinite(typicalGap)) return lines;

  const font = typicalFontSize(ordered.flatMap(line => line.words));
  const dataStart = ordered[Math.floor(ordered.length * 0.2)]?.top ?? 0;
  const tableX0 = columns[0].x0;
  const tableX1 = columns[columns.length - 1].x1;

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const current = ordered[i];
    if (current.top < dataStart) continue;

    const gap = current.top - prev.bottom;

    // Jangan potong baris jika gap vertikal masih wajar
    if (gap < Math.max(14, font * 3.0, typicalGap * 2.2)) continue;

    // Cek apakah teks masih berada dalam batas horizontal tabel
    const isInsideTable = current.words.every(w => w.x0 >= tableX0 - 6 && w.x1 <= tableX1 + 6);
    if (isInsideTable && gap < Math.max(25, font * 4.5)) {
      continue;
    }

    const cells = assignToColumns(current.words, columns);
    const populated = cells.filter(cell => cell?.text).length;
    const firstFilled = !!cells[0]?.text;
    const aligned = headerCenters.length
      ? headerCenters.filter(center =>
          current.words.some(w => center >= w.x0 - 10 && center <= w.x1 + 10)
        ).length
      : populated;

    const firstText = normalizeText(cells[0]?.text || "");
    const codeLike = /^[A-Z]{0,6}\d[A-Z0-9._\/-]{2,}$/i.test(firstText) ||
      /^[+-]?0\d/.test(firstText);

    const lowFit =
      aligned < Math.max(2, Math.ceil(columns.length * 0.5)) &&
      (!firstFilled || !codeLike);

    const numericCount = current.words.filter(w => numericLikeForLayout(w.text)).length;
    const sparseFooterBlock =
      !codeLike &&
      populated <= Math.max(2, Math.ceil(columns.length * 0.35)) &&
      numericCount <= 2;

    if (lowFit || sparseFooterBlock) return ordered.slice(0, i);
  }

  return lines;
}

function buildStreamRows(pageContent, layout, options) {
  const { columns, lines } = layout;

  const usableLines = trimOutsideTableLines(lines, columns, layout.adaptive?.header);
  const drafts = usableLines
    .map(line => ({
      top: line.top,
      bottom: line.bottom,
      words: line.words,
      cells: assignToColumns(line.words, columns)
    }))
    .filter(draft => draft.cells.some(cell => cell.text));

  if (!drafts.length) return [];

  const fillRatio = columns.map(
    (_, index) => drafts.filter(d => d.cells[index].text).length / drafts.length
  );

  const anchors = fillRatio
    .map((ratio, index) => ({ ratio, index }))
    .filter(item => item.ratio >= 0.8)
    .map(item => item.index);

  const gaps = [];
  for (let i = 1; i < drafts.length; i++) {
    gaps.push(drafts[i].top - drafts[i - 1].bottom);
  }

  const typicalGap = median(gaps.filter(g => g >= 0));
  const joinWrapped = options.joinWrapped !== false;

  const rows = [];

  for (const draft of drafts) {
    const previous = rows[rows.length - 1];
    const gap = previous ? draft.top - previous.bottom : Infinity;

    const emptyAnchors = anchors.filter(index => !draft.cells[index].text).length;
    const tighter = Number.isFinite(gap) && typicalGap > 0 && gap <= typicalGap * 0.7;

    const sparse =
      anchors.length > 0 &&
      !draft.cells[anchors[0]].text &&
      emptyAnchors / anchors.length >= 0.6;

    const populatedCount = draft.cells.filter(cell => cell?.text).length;
    const narrowContinuationShape =
      populatedCount <= Math.max(1, Math.ceil(columns.length * 0.35));

    // Jika baris saat ini dan baris sebelumnya sama-sama mengisi kolom yang sama dengan teks valid,
    // maka ini adalah baris baru terpisah, bukan sambungan teks (wrap)
    const isSameColumnColliding = previous && draft.cells.some((cell, idx) =>
      Boolean(cell.text && previous.cells[idx]?.text && cell.text.trim().length > 1)
    );

    let isContinuation =
      joinWrapped &&
      previous &&
      !isSameColumnColliding &&
      anchors.length > 0 &&
      gap <= Math.max(typicalGap * 1.8, 3) &&
      tighter &&
      sparse &&
      narrowContinuationShape &&
      emptyAnchors > 0;

    if (isContinuation) {
      draft.cells.forEach((cell, index) => {
        if (!cell.text) return;
        const target = previous.cells[index];
        target.text = target.text ? `${target.text} ${cell.text}` : cell.text;
        target.colspan = Math.max(target.colspan, cell.colspan);
      });
      previous.bottom = draft.bottom;
      previous.words.push(...draft.words);
      continue;
    }

    rows.push(makeRow(draft.cells, draft.top, draft.bottom, draft.words));
  }

  return rows;
}

function makeRow(cells, top, bottom, words = []) {
  const source = words.length ? words : cells.flatMap(cell => cell?.parts || []);
  const bold = isBoldRow(source);

  return {
    cells: cells.map(cell => (cell ? { ...cell, parts: undefined } : null)),
    top,
    bottom,
    bold,
    words: [...source],
    fontSize: median(source.map(w => w.fontSize))
  };
}

function isBoldRow(words) {
  if (!words.length) return false;
  const bold = words.filter(w => /bold|black|heavy|semib/i.test(w.fontFamily || "")).length;
  return bold / words.length >= 0.5;
}

export function inferOcrColumnModelForTest(pageContent, visualGrid = null) {
  return inferOcrAnchorColumns(pageContent, visualGrid);
}

export function detectHorizontalRowRecoveryForTest(pageContent, fontSize = typicalFontSize(pageContent.words || [])) {
  return detectHorizontalRowRecovery(pageContent, fontSize);
}
