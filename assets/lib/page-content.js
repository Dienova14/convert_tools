/* =========================================================
   page-content.js — baca isi satu halaman

   Semua koordinat dinormalisasi ke ruang viewport:
   - sumbu Y menghadap ke BAWAH (seperti layar)
   - rotasi halaman sudah diterapkan, jadi PDF landscape
     tidak perlu penanganan khusus lagi
   ========================================================= */

import { extractRulings } from "./rulings.js";
import { maskDigits, median, normalizeText } from "./geometry.js";

export async function readPage(page, pdfjs, { readRulings = true, stripTableFooter = false } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const words = [];

  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;

    const box = toBox(item, viewport, pdfjs);
    if (!box) continue;

    const style = textContent.styles?.[item.fontName];
    const fontFamily = style?.fontFamily || "";

    for (const piece of splitWideGaps({ ...box, text: item.str, fontFamily })) {
      words.push(piece);
    }
  }

  let rulings = { horizontal: [], vertical: [] };

  if (readRulings) {
    try {
      const opList = await page.getOperatorList();
      rulings = extractRulings(opList, viewport.transform, pdfjs);
    } catch (error) {
      // PDF dengan konten vector aneh tidak boleh menggagalkan seluruh proses.
      console.warn("Gagal membaca garis tabel, lanjut pakai deteksi spasi.", error);
    }
  }

  // Beberapa PDF menaruh nomor halaman / footer di bawah tabel.
  // Jangan membuang footer hanya berdasarkan teks ("1", "2", dst.),
  // karena angka tersebut bisa saja merupakan data yang sah.
  // Jika garis tabel terbaca, gunakan garis horizontal bawah tabel
  // sebagai batas geometris. Dengan begitu PDF tanpa border tetap
  // memakai perilaku lama.
  const cleanedWords = stripTableFooter
    ? stripBelowTableFooter(words, rulings, viewport)
    : words;

  return {
    width: viewport.width,
    height: viewport.height,
    words: cleanedWords,
    rulings,
    hasText: cleanedWords.length > 0
  };
}

/**
 * Ubah item teks pdf.js menjadi kotak (bounding box) di ruang viewport.
 * Menghitung empat sudut supaya teks miring/berputar tetap dapat kotak benar.
 */
function toBox(item, viewport, pdfjs) {
  const m = pdfjs.Util.transform(viewport.transform, item.transform);

  const advance = Math.hypot(m[0], m[1]) || 1;
  const rise = Math.hypot(m[2], m[3]) || 1;

  const ux = m[0] / advance;
  const uy = m[1] / advance;
  const vx = m[2] / rise;
  const vy = m[3] / rise;

  const w = item.width || 0;
  const h = item.height || rise;

  const ox = m[4];
  const oy = m[5];

  const corners = [
    [ox, oy],
    [ox + ux * w, oy + uy * w],
    [ox + vx * h, oy + vy * h],
    [ox + ux * w + vx * h, oy + uy * w + vy * h]
  ];

  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);

  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  if (!Number.isFinite(x0) || !Number.isFinite(top)) return null;

  return {
    x0,
    x1,
    top,
    bottom,
    fontSize: h,
    vertical: Math.abs(uy) > Math.abs(ux) // teks diputar 90°, mis. header sempit
  };
}

/**
 * Sebagian PDF memancarkan satu baris penuh sebagai satu item teks,
 * dengan kolom dipisah spasi berulang. Kalau dibiarkan, seluruh baris
 * masuk ke satu kolom. Pecah di spasi ganda, lebar diperkirakan
 * proporsional terhadap jumlah karakter.
 */

/**
 * Buang text object yang berada di bawah batas bawah tabel yang
 * benar-benar terlihat dari ruling horizontal.
 *
 * Ini sengaja hanya aktif jika:
 * - ada beberapa garis vertikal (indikasi tabel bergaris),
 * - ada garis horizontal panjang di bagian bawah halaman,
 * - dan ada text di bawah garis tersebut.
 *
 * Dengan demikian angka footer seperti "1"/"2" pada PDF Sandvik
 * tidak menjadi baris Excel, tetapi angka valid pada PDF tanpa
 * border tidak ikut terhapus.
 */
function stripBelowTableFooter(words, rulings, viewport) {
  const horizontal = (rulings?.horizontal || [])
    .filter(line =>
      Number.isFinite(line.y) &&
      Number.isFinite(line.x0) &&
      Number.isFinite(line.x1) &&
      line.x1 > line.x0
    );

  const vertical = (rulings?.vertical || [])
    .filter(line =>
      Number.isFinite(line.x) &&
      Number.isFinite(line.y0) &&
      Number.isFinite(line.y1)
    );

  // Conservative guard: this filter only activates when the page has enough
  // table geometry to identify a real bottom boundary. It is opt-in and is
  // used only by Adaptive, never Catalog.
  if (horizontal.length < 2 || vertical.length < 3) return words;

  const vx0 = Math.min(...vertical.map(v => v.x));
  const vx1 = Math.max(...vertical.map(v => v.x));
  const vSpan = Math.max(1, vx1 - vx0);

  // Candidate bottom rules must be near the lower portion of the page and
  // overlap the vertical table span substantially. This avoids treating a
  // decorative/footer line elsewhere as the table boundary.
  const candidates = horizontal.filter(line => {
    const overlap = Math.max(0, Math.min(line.x1, vx1) - Math.max(line.x0, vx0));
    const ratio = overlap / Math.max(1, Math.min(line.x1 - line.x0, vSpan));
    return (
      line.y >= viewport.height * 0.55 &&
      line.y < viewport.height - 12 &&
      ratio >= 0.60
    );
  });

  if (!candidates.length) return words;

  // Prefer the lowest candidate that is still plausibly a table boundary.
  const tableBottom = Math.max(...candidates.map(line => line.y));

  const below = words.filter(word => word.top > tableBottom + 3);
  if (!below.length) return words;

  // Determine whether there is a second structured table below the boundary.
  // If there are several horizontally aligned rows with the same vertical
  // column geometry, preserve them. A footer/contact block normally lacks
  // repeated column alignment and has very few rows.
  const lowerRows = [];
  const sorted = below.slice().sort((a,b) => a.top - b.top || a.x0 - b.x0);
  for (const word of sorted) {
    let row = lowerRows.find(r => Math.abs(r.y - word.top) <= Math.max(3, word.fontSize * 0.45));
    if (!row) {
      row = { y: word.top, words: [] };
      lowerRows.push(row);
    }
    row.words.push(word);
  }

  const substantialRows = lowerRows.filter(r => r.words.length >= 2);
  const repeatedColumnRows = substantialRows.filter(r => {
    const xs = r.words.map(w => w.x0).sort((a,b) => a-b);
    if (xs.length < 2) return false;
    const spread = xs[xs.length - 1] - xs[0];
    return spread >= viewport.width * 0.20;
  });

  // If there is a meaningful second table-like block below, do not discard it.
  if (repeatedColumnRows.length >= 2) return words;

  // Otherwise the entire post-boundary block is outside the detected table.
  // This intentionally handles long company/address/contact footers too;
  // unlike the old implementation, it is not restricted to tiny text.
  const removed = new Set(below);
  return words.filter(word => !removed.has(word));
}
function splitWideGaps(word) {
  const raw = word.text;

  if (!/ {2,}/.test(raw) || word.vertical) {
    return [{ ...word, text: normalizeText(raw) }].filter(w => w.text);
  }

  const span = word.x1 - word.x0;
  const total = raw.length || 1;
  const parts = [];

  let cursor = 0;

  for (const chunk of raw.split(/( {2,})/)) {
    const start = cursor;
    cursor += chunk.length;

    const text = normalizeText(chunk);
    if (!text) continue;

    parts.push({
      ...word,
      text,
      x0: word.x0 + (span * start) / total,
      x1: word.x0 + (span * cursor) / total
    });
  }

  return parts.length ? parts : [{ ...word, text: normalizeText(raw) }];
}

/**
 * Buang kop/footer yang berulang di banyak halaman
 * (judul laporan, "Halaman 3 dari 12", tanggal cetak).
 * Deteksi berbasis pengulangan, bukan daftar kata kunci.
 */
export function stripRunningHeaders(pages, { threshold = 0.8, bandRatio = 0.08, preserveRepeatedHeaders = true } = {}) {
  if (pages.length < 3) return { removed: 0 };

  const counter = new Map();
  // Tandai baris atas yang sangat mungkin merupakan header tabel berulang.
  // Header sengaja dipertahankan sampai buildDocumentTable() selesai memilih
  // header. Ini penting karena jika dihapus di sini, resolveHeader() tidak
  // pernah bisa mengembalikan header ke Excel.
  const preservedHeaderWords = new Set();

  if (preserveRepeatedHeaders) {
    const lineSignatureMap = new Map();

    for (const page of pages) {
      const band = page.height * bandRatio;
      const topWords = page.words
        .filter(word => word.top <= band && !word.vertical)
        .sort((a, b) => a.top - b.top || a.x0 - b.x0);

      const lines = [];
      for (const word of topWords) {
        const height = Math.max(1, word.bottom - word.top);
        let line = null;

        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
          const candidate = lines[i];
          const shared = Math.max(
            0,
            Math.min(candidate.bottom, word.bottom) -
            Math.max(candidate.top, word.top)
          );
          const minHeight = Math.min(candidate.bottom - candidate.top, height) || 1;

          if (shared / minHeight >= 0.4) {
            line = candidate;
            break;
          }
        }

        if (!line) {
          line = { top: word.top, bottom: word.bottom, words: [] };
          lines.push(line);
        }

        line.words.push(word);
        line.top = Math.min(line.top, word.top);
        line.bottom = Math.max(line.bottom, word.bottom);
      }

      for (const line of lines) {
        line.words.sort((a, b) => a.x0 - b.x0);

        const text = normalizeText(line.words.map(word => word.text).join(" "));
        const nonNumeric = line.words.filter(word => !/^[+-]?\d+$/.test(normalizeText(word.text)));
        const span = line.words.length
          ? line.words[line.words.length - 1].x1 - line.words[0].x0
          : 0;

        // Header generic: beberapa label tersebar secara horizontal.
        // Tidak memakai nama header tertentu.
        const headerLike =
          line.words.length >= 3 &&
          nonNumeric.length >= 2 &&
          span >= page.width * 0.35 &&
          text.length >= 8;

        if (!headerLike) continue;

        const signature = line.words
          .map(word => normalizeText(word.text).toLowerCase())
          .join("|");

        if (!signature) continue;

        const key = `${Math.round(line.top / 5)}|${signature}`;
        const entry = lineSignatureMap.get(key) || { count: 0, lines: [] };
        entry.count++;
        entry.lines.push(line);
        lineSignatureMap.set(key, entry);
      }
    }

    // Preserve short continuation lines that belong to a detected header
    // band. This is structural, not vocabulary-based.
    for (const page of pages) {
      const band = page.height * bandRatio;
      const topLines = [];
      const words = page.words
        .filter(word => word.top <= band && !word.vertical)
        .sort((a, b) => a.top - b.top || a.x0 - b.x0);

      for (const word of words) {
        const height = Math.max(1, word.bottom - word.top);
        let line = null;
        for (let i = topLines.length - 1; i >= Math.max(0, topLines.length - 3); i--) {
          const candidate = topLines[i];
          const shared = Math.max(
            0,
            Math.min(candidate.bottom, word.bottom) -
            Math.max(candidate.top, word.top)
          );
          const minHeight = Math.min(candidate.bottom - candidate.top, height) || 1;
          if (shared / minHeight >= 0.4) {
            line = candidate;
            break;
          }
        }
        if (!line) {
          line = { top: word.top, bottom: word.bottom, words: [] };
          topLines.push(line);
        }
        line.words.push(word);
        line.top = Math.min(line.top, word.top);
        line.bottom = Math.max(line.bottom, word.bottom);
      }

      const structuralHeaders = topLines.filter(line => {
        const nonNumericCount = line.words.filter(word =>
          !/^[+-]?\d+$/.test(normalizeText(word.text))
        ).length;
        const span = line.words.length
          ? Math.max(...line.words.map(word => word.x1)) - Math.min(...line.words.map(word => word.x0))
          : 0;
        return line.words.length >= 3 &&
          nonNumericCount >= 2 &&
          span >= page.width * 0.35 &&
          normalizeText(line.words.map(word => word.text).join(" ")).length >= 8;
      });

      if (!structuralHeaders.length) continue;

      for (const line of topLines) {
        if (line.words.length > 3) continue;

        const close = structuralHeaders.some(header => {
          const verticalGap = line.top >= header.bottom
            ? line.top - header.bottom
            : header.top - line.bottom;
          return verticalGap <= Math.max(14, page.height * 0.018);
        });

        if (!close) continue;

        for (const word of line.words) preservedHeaderWords.add(word);
      }
    }

    const minPages = Math.ceil(pages.length * threshold);

    for (const entry of lineSignatureMap.values()) {
      if (entry.count < minPages) continue;

      for (const line of entry.lines) {
        for (const word of line.words) preservedHeaderWords.add(word);
      }
    }
  }


  const bandOf = (page, word) => {
    const band = page.height * bandRatio;
    if (word.top <= band) return "top";
    if (word.bottom >= page.height - band) return "bottom";
    return null;
  };

  for (const page of pages) {
    const seen = new Set();

    for (const word of page.words) {
      const band = bandOf(page, word);
      if (!band) continue;
      if (preservedHeaderWords.has(word)) continue;

      const text = normalizeText(word.text).toLowerCase();

      // Angka murni jangan dimask dan jangan dianggap running header.
      // Kode seperti 00123/00045 dapat berada di area atas halaman.
      const numericOnly = /^[+-]?\d+$/.test(text);
      if (numericOnly) continue;

      const signature = /\d/.test(text) ? maskDigits(text) : text;
      const key = `${band}|${Math.round(word.top / 6)}|${signature}`;
      if (seen.has(key)) continue;
      seen.add(key);

      counter.set(key, (counter.get(key) || 0) + 1);
    }
  }

  const repeated = new Set(
    [...counter.entries()]
      .filter(([, count]) => count >= Math.ceil(pages.length * threshold))
      .map(([key]) => key)
  );

  if (!repeated.size) return { removed: 0 };

  let removed = 0;

  for (const page of pages) {
    page.words = page.words.filter(word => {
      const band = bandOf(page, word);
      if (!band) return true;
      if (preservedHeaderWords.has(word)) return true;

      const text = normalizeText(word.text).toLowerCase();
      const numericOnly = /^[+-]?\d+$/.test(text);
      if (numericOnly) return true;

      const signature = /\d/.test(text) ? maskDigits(text) : text;
      const key = `${band}|${Math.round(word.top / 6)}|${signature}`;
      if (repeated.has(key)) {
        removed++;
        return false;
      }
      return true;
    });
  }

  return { removed };
}

/** Tinggi baris tipikal, dipakai sebagai satuan toleransi adaptif. */
export function typicalFontSize(words) {
  return median(words.map(w => w.fontSize)) || 10;
}
