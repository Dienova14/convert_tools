/* =========================================================
   rulings.js — membaca garis border tabel dari vector PDF

   Ini bagian yang hilang di versi lama. Banyak PDF tabel
   menggambar border sebagai garis (stroke) atau kotak tipis
   (fill). Kalau garisnya bisa dibaca, struktur tabel tidak
   perlu ditebak dari posisi teks lagi.
   ========================================================= */

import { cluster1D } from "./geometry.js";

const MAX_LINE_THICKNESS = 4; // pt — di atas ini dianggap blok warna, bukan garis
const MIN_LINE_LENGTH = 6;    // pt — di bawah ini dianggap noise

/**
 * @param {object} opList hasil page.getOperatorList()
 * @param {number[]} baseTransform viewport.transform
 * @param {object} pdfjs modul pdf.js (butuh OPS & Util)
 * @returns {{horizontal: Array, vertical: Array}} koordinat device (y ke bawah)
 */
export function extractRulings(opList, baseTransform, pdfjs) {
  const { OPS, Util } = pdfjs;

  let ctm = baseTransform.slice();
  let lineWidth = 1;

  const ctmStack = [];
  const widthStack = [];
  const segments = [];

  let path = [];

  const toDevice = (x, y) => Util.applyTransform([x, y], ctm);

  const pushSegment = (x0, y0, x1, y1) => {
    const a = toDevice(x0, y0);
    const b = toDevice(x1, y1);
    path.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
  };

  const flush = (isFill) => {
    const scale = Math.hypot(ctm[0], ctm[1]) || 1;
    const thickness = isFill ? 0 : Math.max(lineWidth * scale, 0.1);
    for (const seg of path) segments.push({ ...seg, thickness });
    path = [];
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    switch (fn) {
      case OPS.save:
        ctmStack.push(ctm.slice());
        widthStack.push(lineWidth);
        break;

      case OPS.restore:
        ctm = ctmStack.pop() || ctm;
        lineWidth = widthStack.pop() ?? lineWidth;
        break;

      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;

      case OPS.setLineWidth:
        lineWidth = Number(args[0]) || lineWidth;
        break;

      case OPS.constructPath:
        readPath(args, OPS, pushSegment);
        break;

      case OPS.rectangle:
        // beberapa versi pdf.js memancarkan rectangle terpisah
        if (args && args.length >= 4) {
          const [x, y, w, h] = args;
          pushRect(x, y, w, h, pushSegment);
        }
        break;

      case OPS.stroke:
      case OPS.closeStroke:
        flush(false);
        break;

      case OPS.fill:
      case OPS.eoFill:
      case OPS.closeFillStroke:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeEOFillStroke:
        flush(true);
        break;

      case OPS.endPath:
        path = [];
        break;

      default:
        break;
    }
  }

  return classify(segments);
}

function readPath(args, OPS, pushSegment) {
  const pathOps = args?.[0];
  const coords = args?.[1];
  if (!pathOps || !coords) return;

  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let k = 0;

  for (const op of pathOps) {
    switch (op) {
      case OPS.moveTo:
        x = coords[k++];
        y = coords[k++];
        startX = x;
        startY = y;
        break;

      case OPS.lineTo: {
        const nx = coords[k++];
        const ny = coords[k++];
        pushSegment(x, y, nx, ny);
        x = nx;
        y = ny;
        break;
      }

      case OPS.curveTo:
        k += 4;
        x = coords[k++];
        y = coords[k++];
        break;

      case OPS.curveTo2:
      case OPS.curveTo3:
        k += 2;
        x = coords[k++];
        y = coords[k++];
        break;

      case OPS.closePath:
        pushSegment(x, y, startX, startY);
        x = startX;
        y = startY;
        break;

      case OPS.rectangle: {
        const rx = coords[k++];
        const ry = coords[k++];
        const rw = coords[k++];
        const rh = coords[k++];
        pushRect(rx, ry, rw, rh, pushSegment);
        x = rx;
        y = ry;
        startX = rx;
        startY = ry;
        break;
      }

      default:
        break;
    }
  }
}

function pushRect(x, y, w, h, pushSegment) {
  const thin = Math.min(Math.abs(w), Math.abs(h));

  if (thin <= MAX_LINE_THICKNESS) {
    // kotak tipis = garis. Ambil garis tengahnya saja.
    if (Math.abs(w) >= Math.abs(h)) {
      const cy = y + h / 2;
      pushSegment(x, cy, x + w, cy);
    } else {
      const cx = x + w / 2;
      pushSegment(cx, y, cx, y + h);
    }
    return;
  }

  // kotak besar: ambil keempat sisinya (border sel yang digambar utuh)
  pushSegment(x, y, x + w, y);
  pushSegment(x + w, y, x + w, y + h);
  pushSegment(x + w, y + h, x, y + h);
  pushSegment(x, y + h, x, y);
}

function classify(segments) {
  const horizontal = [];
  const vertical = [];

  for (const seg of segments) {
    const dx = Math.abs(seg.x1 - seg.x0);
    const dy = Math.abs(seg.y1 - seg.y0);
    const tolerance = Math.max(1.2, seg.thickness);

    if (dy <= tolerance && dx >= MIN_LINE_LENGTH) {
      horizontal.push({
        y: (seg.y0 + seg.y1) / 2,
        x0: Math.min(seg.x0, seg.x1),
        x1: Math.max(seg.x0, seg.x1)
      });
    } else if (dx <= tolerance && dy >= MIN_LINE_LENGTH) {
      vertical.push({
        x: (seg.x0 + seg.x1) / 2,
        y0: Math.min(seg.y0, seg.y1),
        y1: Math.max(seg.y0, seg.y1)
      });
    }
  }

  return {
    horizontal: mergeCollinear(horizontal, "y", "x0", "x1"),
    vertical: mergeCollinear(vertical, "x", "y0", "y1")
  };
}

/** Gabungkan potongan garis yang sebenarnya satu garis panjang. */
function mergeCollinear(lines, axisKey, startKey, endKey, tolerance = 2.5, joinGap = 4) {
  if (!lines.length) return [];

  const levels = cluster1D(lines.map(l => l[axisKey]), tolerance);
  const merged = [];

  for (const level of levels) {
    const group = lines
      .filter(l => Math.abs(l[axisKey] - level) <= tolerance)
      .sort((a, b) => a[startKey] - b[startKey]);

    let current = null;

    for (const line of group) {
      if (current && line[startKey] - current[endKey] <= joinGap) {
        current[endKey] = Math.max(current[endKey], line[endKey]);
      } else {
        if (current) merged.push(current);
        current = { [axisKey]: level, [startKey]: line[startKey], [endKey]: line[endKey] };
      }
    }

    if (current) merged.push(current);
  }

  return merged.filter(l => l[endKey] - l[startKey] >= MIN_LINE_LENGTH);
}

/** Apakah ada garis horizontal di y yang menutupi rentang x tertentu. */
export function hasHorizontalLine(rulings, y, x0, x1, tolerance = 3, coverage = 0.65) {
  const width = Math.max(1, x1 - x0);
  let covered = 0;

  for (const line of rulings.horizontal) {
    if (Math.abs(line.y - y) > tolerance) continue;
    covered += Math.max(0, Math.min(line.x1, x1) - Math.max(line.x0, x0));
  }

  return covered / width >= coverage;
}

/** Apakah ada garis vertikal di x yang menutupi rentang y tertentu. */
export function hasVerticalLine(rulings, x, y0, y1, tolerance = 3, coverage = 0.65) {
  const height = Math.max(1, y1 - y0);
  let covered = 0;

  for (const line of rulings.vertical) {
    if (Math.abs(line.x - x) > tolerance) continue;
    covered += Math.max(0, Math.min(line.y1, y1) - Math.max(line.y0, y0));
  }

  return covered / height >= coverage;
}
