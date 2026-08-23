/* =========================================================
   ocr-adapter.js — OCR -> Page Model adapter

   OCR Adaptive adalah mode TERPISAH.
   Modul ini hanya mengubah hasil OCR menjadi model halaman yang sama
   dengan PDF.js: words + x0/x1/top/bottom/fontSize.

   Setelah adapter selesai, table.js/document.js yang sudah ada tetap
   digunakan. Jadi OCR tidak mempunyai engine tabel kedua.
   ========================================================= */

let worker = null;
let workerLanguage = null;

const TESSERACT_CDN_VERSION = "7.0.0";
const DEFAULT_SCALE = 3;

function getTesseract() {
  const api = globalThis.Tesseract;
  if (!api?.createWorker) {
    throw new Error(
      "Tesseract.js belum tersedia. Pastikan script Tesseract.js termuat dari CDN."
    );
  }
  return api;
}

function normalizeOcrLanguage(language = "eng") {
  const raw = String(language || "eng").trim();
  if (!raw) return "eng";

  const parts = raw
    .split("+")
    .map(value => value.trim())
    .filter(Boolean);

  return parts.length > 1 ? parts : (parts[0] || "eng");
}

function languageKey(language) {
  return Array.isArray(language) ? language.join("+") : String(language);
}

export async function getOcrWorker(language = "eng", logger = null) {
  const lang = normalizeOcrLanguage(language);
  const key = languageKey(lang);

  if (worker && workerLanguage === key) return worker;

  if (worker) {
    await worker.terminate();
    worker = null;
    workerLanguage = null;
  }

  const Tesseract = getTesseract();
  worker = await Tesseract.createWorker(lang, 1, {
    logger: message => {
      if (typeof logger === "function") logger(message);
    }
  });

  // Preserve spaces so OCR word positions remain useful for adaptive columns.
  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "3"
  });

  workerLanguage = key;
  return worker;
}

export async function terminateOcrWorker() {
  if (!worker) return;
  await worker.terminate();
  worker = null;
  workerLanguage = null;
}

function parseTsv(tsv, scale, pageWidth, pageHeight) {
  const lines = String(tsv || "").split(/\r?\n/);
  if (!lines.length) return [];

  const words = [];
  const header = lines[0].split("\t");
  const index = new Map(header.map((name, i) => [name, i]));

  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    const fields = raw.split("\t");
    const level = Number(fields[index.get("level")]);
    if (level !== 5) continue;

    const text = String(fields[index.get("text")] ?? "").trim();
    if (!text) continue;

    const left = Number(fields[index.get("left")]);
    const top = Number(fields[index.get("top")]);
    const width = Number(fields[index.get("width")]);
    const height = Number(fields[index.get("height")]);
    const confidence = Number(fields[index.get("conf")]);

    if (![left, top, width, height].every(Number.isFinite)) continue;
    if (width <= 0 || height <= 0) continue;

    const x0 = left / scale;
    const x1 = (left + width) / scale;
    const y0 = top / scale;
    const y1 = (top + height) / scale;

    // Clamp only to the original PDF viewport. OCR may occasionally emit
    // a pixel or two outside the image edge.
    words.push({
      text,
      x0: Math.max(0, Math.min(pageWidth, x0)),
      x1: Math.max(0, Math.min(pageWidth, x1)),
      top: Math.max(0, Math.min(pageHeight, y0)),
      bottom: Math.max(0, Math.min(pageHeight, y1)),
      fontSize: Math.max(2, height / scale),
      fontFamily: "OCR",
      bold: false,
      vertical: false,
      confidence: Number.isFinite(confidence) ? confidence : null,
      source: "ocr"
    });
  }

  return words.filter(word => word.x1 > word.x0 && word.bottom > word.top);
}

function averageConfidence(words) {
  const values = words
    .map(word => Number(word.confidence))
    .filter(value => Number.isFinite(value) && value >= 0);

  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length / 100;
}


function parseBlocks(blocks, scale, pageWidth, pageHeight) {
  const words = [];

  const visit = node => {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    // Tesseract.js v6/v7 exposes structured blocks -> paragraphs -> lines -> words.
    if (node.words && Array.isArray(node.words)) {
      for (const word of node.words) {
        const text = String(word?.text ?? "").trim();
        const bbox = word?.bbox;
        if (!text || !bbox) continue;

        const x0 = Number(bbox.x0);
        const y0 = Number(bbox.y0);
        const x1 = Number(bbox.x1);
        const y1 = Number(bbox.y1);
        const confidence = Number(word.confidence);

        if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
        if (x1 <= x0 || y1 <= y0) continue;

        words.push({
          text,
          x0: Math.max(0, Math.min(pageWidth, x0 / scale)),
          x1: Math.max(0, Math.min(pageWidth, x1 / scale)),
          top: Math.max(0, Math.min(pageHeight, y0 / scale)),
          bottom: Math.max(0, Math.min(pageHeight, y1 / scale)),
          fontSize: Math.max(2, (y1 - y0) / scale),
          fontFamily: "OCR",
          bold: false,
          vertical: false,
          confidence: Number.isFinite(confidence) ? confidence : null,
          source: "ocr"
        });
      }
      return;
    }

    // Some builds expose nested paragraphs/lines rather than a direct words array.
    if (node.paragraphs) visit(node.paragraphs);
    if (node.lines) visit(node.lines);
  };

  visit(blocks);

  const seen = new Set();
  return words.filter(word => {
    const key = [
      word.text,
      Math.round(word.x0 * 10),
      Math.round(word.top * 10),
      Math.round(word.x1 * 10),
      Math.round(word.bottom * 10)
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


/* ---------------------------------------------------------
   Visual grid detection v0.4

   OCR words alone cannot represent an empty/image column and cannot reliably
   distinguish a visual table row from an OCR text line. For OCR Adaptive only,
   inspect the rendered page image for long neutral/light grid lines.

   This is intentionally a conservative detector:
   - looks for long, low-saturation runs;
   - clusters nearby pixel rows/columns;
   - derives vertical lines from the strongest horizontal-table region;
   - never changes the normal PDF-text Adaptive path.
   --------------------------------------------------------- */

function clusterNumeric(values, tolerance = 4) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const groups = [];

  for (const value of sorted) {
    const last = groups[groups.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) {
      last.push(value);
    } else {
      groups.push([value]);
    }
  }

  return groups.map(group => group.reduce((a, b) => a + b, 0) / group.length);
}

function maxTrueRun(flags) {
  let best = 0;
  let run = 0;
  for (const flag of flags) {
    if (flag) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

function clusterProfileCandidates(values, tolerance = 3) {
  const sorted = values
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);

  const clusters = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) {
      last.push(value);
    } else {
      clusters.push([value]);
    }
  }

  return clusters.map(group => ({
    position: group.reduce((sum, value) => sum + value, 0) / group.length,
    count: group.length
  }));
}

function medianValue(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function chooseRegularSequence(candidates, totalSpan, minCount = 4) {
  if (candidates.length < minCount) return [];

  let best = null;

  for (let start = 0; start <= candidates.length - minCount; start++) {
    for (let end = start + minCount - 1; end < candidates.length; end++) {
      const positions = candidates.slice(start, end + 1).map(item => item.position);
      const gaps = positions.slice(1).map((value, index) => value - positions[index]);

      if (!gaps.length) continue;

      const typical = medianValue(gaps);
      if (!(typical > 0)) continue;

      let score = positions.length * 2;
      let badSmall = 0;
      let badLarge = 0;

      for (const gap of gaps) {
        const ratio = gap / typical;

        if (ratio < 0.38) {
          badSmall++;
          score -= 3.0;
        } else if (ratio > 2.55) {
          badLarge++;
          score -= 2.5;
        } else if (ratio >= 0.55 && ratio <= 1.55) {
          score += 1.5;
        } else {
          score += 0.3;
        }
      }

      const spanRatio = Math.max(0, Math.min(1, (positions.at(-1) - positions[0]) / totalSpan));
      score += spanRatio * 5;

      // A good table grid normally covers a substantial portion of the page.
      if (spanRatio < 0.30) score -= 5;

      // Prefer a long, regular sequence over a sequence that accidentally
      // includes the page's outer decorative border.
      score -= badSmall * 1.5;
      score -= badLarge * 0.5;

      if (!best || score > best.score) {
        best = { positions, typical, score };
      }
    }
  }

  return best ? best.positions : [];
}

function inferMissingGridSeparators(separators, words, axis = "y") {
  if (separators.length < 4) return separators;

  const gaps = separators.slice(1).map((value, index) => value - separators[index]);
  const normalGaps = gaps.filter(gap => gap > 0);
  const typical = medianValue(normalGaps);
  if (!(typical > 0)) return separators;

  const result = [separators[0]];

  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    const a = separators[i];
    const b = separators[i + 1];
    const ratio = gap / typical;

    let inserted = null;

    // A missing table separator is often caused by a colored header rule
    // that is not neutral/gray. Only infer one separator when the gap is
    // close to exactly two normal row heights.
    if (axis === "y" && ratio >= 1.65 && ratio <= 2.35) {
      const gapWords = (words || [])
        .filter(word => {
          const center = (word.top + word.bottom) / 2;
          return center > a + 4 && center < b - 4;
        })
        .sort((left, right) => left.top - right.top || left.x0 - right.x0);

      if (gapWords.length >= 2) {
        // Find OCR line clusters inside the missing-separator gap.
        const lineClusters = [];
        for (const word of gapWords) {
          const last = lineClusters[lineClusters.length - 1];
          const tolerance = Math.max(3, Number(word.fontSize || 8) * 0.65);
          if (last && word.top - last.bottom <= tolerance) {
            last.bottom = Math.max(last.bottom, word.bottom);
            last.words.push(word);
          } else {
            lineClusters.push({
              top: word.top,
              bottom: word.bottom,
              words: [word]
            });
          }
        }

        if (lineClusters.length >= 2) {
          let largestBlank = -1;
          let split = null;

          for (let j = 1; j < lineClusters.length; j++) {
            const blank = lineClusters[j].top - lineClusters[j - 1].bottom;
            if (blank > largestBlank) {
              largestBlank = blank;
              split = (lineClusters[j - 1].bottom + lineClusters[j].top) / 2;
            }
          }

          // Do not invent a separator through a dense text block.
          if (split != null && largestBlank >= Math.max(6, typical * 0.10)) {
            inserted = split;
          }
        }
      }

      // If OCR line grouping cannot help, use the exact midpoint only after
      // OCR has supplied words. The initial image-only pass must not invent
      // a separator before text evidence is available.
      if (inserted == null && (words || []).length > 0) {
        inserted = a + typical;
      }
    }

    if (inserted != null && inserted > a + typical * 0.45 && inserted < b - typical * 0.45) {
      result.push(inserted);
    }

    result.push(b);
  }

  return clusterProfileCandidates(
    result,
    Math.max(1.5, typical * 0.04)
  ).map(item => item.position);
}

function detectVisualGrid(canvas, scale, pageWidth, pageHeight, words = []) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { horizontal: [], vertical: [], confidence: 0 };

  const width = canvas.width;
  const height = canvas.height;
  if (width < 100 || height < 100) {
    return { horizontal: [], vertical: [], confidence: 0 };
  }

  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;

  // White page background must NOT be treated as a grid line. We therefore
  // look for neutral gray/dark pixels rather than "anything non-colored".
  const neutralGridPixel = (r, g, b) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max - min;
    const gray = (r + g + b) / 3;
    return saturation <= 28 && gray < 250;
  };

  const sx = Math.max(1, Math.ceil(width / 1600));
  const sy = Math.max(1, Math.ceil(height / 1600));
  const sampleW = Math.ceil(width / sx);
  const sampleH = Math.ceil(height / sy);

  const xProfile = new Float32Array(sampleW);
  const yProfile = new Float32Array(sampleH);

  for (let yi = 0; yi < sampleH; yi++) {
    const y = Math.min(height - 1, yi * sy);
    let count = 0;

    for (let xi = 0; xi < sampleW; xi++) {
      const x = Math.min(width - 1, xi * sx);
      const p = (y * width + x) * 4;
      if (neutralGridPixel(data[p], data[p + 1], data[p + 2])) count++;
    }

    yProfile[yi] = count / Math.max(1, sampleW);
  }

  for (let xi = 0; xi < sampleW; xi++) {
    const x = Math.min(width - 1, xi * sx);
    let count = 0;

    for (let yi = 0; yi < sampleH; yi++) {
      const y = Math.min(height - 1, yi * sy);
      const p = (y * width + x) * 4;
      if (neutralGridPixel(data[p], data[p + 1], data[p + 2])) count++;
    }

    xProfile[xi] = count / Math.max(1, sampleH);
  }

  // Table rules occupy a large fraction of their axis. Text strokes do not.
  const xCandidates = [];
  for (let i = 0; i < sampleW; i++) {
    if (xProfile[i] >= 0.50) xCandidates.push(i * sx / scale);
  }

  const yCandidates = [];
  for (let i = 0; i < sampleH; i++) {
    if (yProfile[i] >= 0.50) yCandidates.push(i * sy / scale);
  }

  const xClusters = clusterProfileCandidates(xCandidates, Math.max(2, 4 / scale));
  const yClusters = clusterProfileCandidates(yCandidates, Math.max(2, 4 / scale));

  const xSequence = chooseRegularSequence(
    xClusters,
    Math.max(1, pageWidth),
    4
  );

  if (xSequence.length < 4) {
    return { horizontal: [], vertical: [], confidence: 0 };
  }

  // Only search horizontal rules inside the selected table width. This
  // prevents the red/black page decoration from becoming row separators.
  const left = xSequence[0];
  const right = xSequence[xSequence.length - 1];

  const tableX0 = Math.round(left * scale);
  const tableX1 = Math.min(width - 1, Math.round(right * scale));
  const tableSpan = Math.max(1, tableX1 - tableX0);

  const yTableCandidates = [];
  for (const cluster of yClusters) {
    const pixelY = Math.min(height - 1, Math.max(0, Math.round(cluster.position * scale)));
    let neutralCount = 0;

    for (let x = tableX0; x <= tableX1; x += Math.max(1, sx)) {
      const p = (pixelY * width + x) * 4;
      if (neutralGridPixel(data[p], data[p + 1], data[p + 2])) neutralCount++;
    }

    const coverage = neutralCount / Math.max(1, Math.ceil(tableSpan / Math.max(1, sx)));
    if (coverage >= 0.60) {
      yTableCandidates.push(cluster.position);
    }
  }

  const ySequence = chooseRegularSequence(
    yTableCandidates.map(position => ({ position })),
    Math.max(1, pageHeight),
    4
  );

  if (ySequence.length < 4) {
    return { horizontal: [], vertical: [], confidence: 0 };
  }

  const completedY = inferMissingGridSeparators(ySequence, words, "y");

  const vertical = xSequence.map(x => ({
    x,
    y0: ySequence[0],
    y1: ySequence[ySequence.length - 1]
  }));

  const horizontal = completedY.map(y => ({
    y,
    x0: left,
    x1: right
  }));

  const expectedColumns = Math.max(1, xSequence.length - 1);
  const expectedRows = Math.max(1, completedY.length - 1);

  const confidence = Math.min(
    0.99,
    0.72 +
      Math.min(0.12, Math.max(0, expectedColumns - 2) * 0.025) +
      Math.min(0.10, Math.max(0, expectedRows - 3) * 0.008) +
      (completedY.length > ySequence.length ? 0.04 : 0)
  );

  return {
    horizontal,
    vertical,
    confidence,
    tableBounds: {
      x0: left,
      x1: right,
      y0: completedY[0],
      y1: completedY[completedY.length - 1]
    },
    columnLines: xSequence,
    rowLines: completedY,
    inferredHorizontal: completedY.length > ySequence.length
  };
}

/**
 * Render one PDF page to an image, OCR it, and return the same page model
 * consumed by the existing adaptive table engine.
 */
export async function readOcrPage(
  page,
  {
    language = "eng",
    scale = DEFAULT_SCALE,
    onProgress = null
  } = {}
) {
  const viewport = page.getViewport({ scale: 1 });
  const renderViewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(renderViewport.width);
  canvas.height = Math.ceil(renderViewport.height);

  const context = canvas.getContext("2d", { willReadFrequently: false });
  if (!context) throw new Error("Canvas OCR tidak tersedia di browser ini.");

  await page.render({
    canvasContext: context,
    viewport: renderViewport
  }).promise;

  const visualGrid = detectVisualGrid(
    canvas,
    scale,
    viewport.width,
    viewport.height,
    [] // OCR words are not available yet; grid inference remains image-first.
  );

  const ocrWorker = await getOcrWorker(language, message => {
    if (typeof onProgress !== "function") return;
    if (message?.status === "recognizing text" && Number.isFinite(message.progress)) {
      onProgress(message.progress);
    }
  });

  const result = await ocrWorker.recognize(
    canvas,
    {},
    { text: true, tsv: true, blocks: true }
  );

  const tsvWords = parseTsv(
    result?.data?.tsv || "",
    scale,
    viewport.width,
    viewport.height
  );

  // Tesseract.js v7 can return structured blocks with word bounding boxes.
  // Prefer TSV when it is populated, but fall back to blocks if a browser/CDN
  // build returns an empty TSV even though OCR found text.
  const blockWords = parseBlocks(
    result?.data?.blocks || [],
    scale,
    viewport.width,
    viewport.height
  );

  const words = tsvWords.length ? tsvWords : blockWords;

  // Re-run only the missing-separator completion with OCR words now available.
  // This keeps image geometry primary while using text line positions to place
  // a missing colored-header rule safely.
  if (visualGrid.rowLines?.length >= 4) {
    const previousRowCount = visualGrid.rowLines.length;
    const completedRows = inferMissingGridSeparators(
      visualGrid.rowLines,
      words,
      "y"
    );
    visualGrid.rowLines = completedRows;
    visualGrid.horizontal = completedRows.map(y => ({
      y,
      x0: visualGrid.tableBounds?.x0 ?? 0,
      x1: visualGrid.tableBounds?.x1 ?? viewport.width
    }));
    visualGrid.inferredHorizontal =
      completedRows.length > previousRowCount;
  }

  canvas.width = 1;
  canvas.height = 1;

  return {
    width: viewport.width,
    height: viewport.height,
    words,
    rulings: {
      horizontal: visualGrid.horizontal,
      vertical: visualGrid.vertical
    },
    visualGrid: {
      columnLines: visualGrid.columnLines || [],
      rowLines: visualGrid.rowLines || [],
      confidence: visualGrid.confidence,
      inferredHorizontal: !!visualGrid.inferredHorizontal
    },
    visualGridConfidence: visualGrid.confidence,
    hasText: words.length > 0,
    source: "ocr",
    ocr: true,
    ocrConfidence: averageConfidence(words),
    ocrWordCount: words.length,
    ocrTextLength: String(result?.data?.text || "").trim().length,
    ocrOutput: tsvWords.length ? "tsv" : (blockWords.length ? "blocks" : "empty"),
    ocrEngine: `Tesseract.js ${TESSERACT_CDN_VERSION}`
  };
}

export function parseOcrTsvForTest(tsv, scale = 1, pageWidth = 10000, pageHeight = 10000) {
  return parseTsv(tsv, scale, pageWidth, pageHeight);
}

export function normalizeOcrLanguageForTest(language = "eng") {
  return normalizeOcrLanguage(language);
}

export function visualGridDetectionAvailableForTest() {
  return typeof detectVisualGrid === "function";
}

export function chooseRegularSequenceForTest(candidates, totalSpan, minCount = 4) {
  const normalized = (candidates || []).map(position => ({ position: Number(position) }));
  return chooseRegularSequence(normalized, Number(totalSpan) || 1, minCount);
}

export function inferMissingGridSeparatorsForTest(separators, words = []) {
  return inferMissingGridSeparators(
    (separators || []).map(Number).filter(Number.isFinite),
    words,
    "y"
  );
}
