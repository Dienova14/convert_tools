/* =========================================================
   geometry.js — helper numerik & teks
   ========================================================= */

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function median(values) {
  const list = values.filter(Number.isFinite);
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Panjang irisan dua interval 1 dimensi. */
export function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Klaster nilai 1 dimensi yang berdekatan.
 * Dipakai untuk menyatukan garis-garis yang sebenarnya satu garis.
 */
export function cluster1D(values, tolerance) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];

  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last.max <= tolerance) {
      last.items.push(value);
      last.max = value;
      last.value = last.items.reduce((s, v) => s + v, 0) / last.items.length;
    } else {
      clusters.push({ value, min: value, max: value, items: [value] });
    }
  }

  return clusters.map(c => c.value);
}

/** Ubah daftar batas menjadi daftar interval kolom/baris. */
export function boundariesToRanges(boundaries) {
  const ranges = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    ranges.push({ x0: boundaries[i], x1: boundaries[i + 1] });
  }
  return ranges;
}

/** Kemiripan dua baris teks (Jaccard token). Dipakai untuk deteksi header berulang. */
export function textSimilarity(a, b) {
  const tokenize = value =>
    new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (!setA.size || !setB.size) return 0;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;

  return shared / (setA.size + setB.size - shared);
}

/** Samarkan angka supaya "Halaman 1 dari 9" dan "Halaman 2 dari 9" dianggap sama. */
export function maskDigits(value) {
  return normalizeText(value).toLowerCase().replace(/\d+/g, "#");
}
