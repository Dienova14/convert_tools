import assert from "node:assert/strict";
import { buildRows } from "../assets/lib/table.js";

function word(text, x, top, width = 20) {
  return { text, x0: x, x1: x + width, top, bottom: top + 8, fontSize: 8, fontFamily: "Helvetica", vertical: false };
}

// Simulate a real catalog page where the thin/colored horizontal rules between
// data rows were missed by ruling detection. The lattice therefore contains a
// large band with multiple genuine data baselines.
const page = {
  width: 500,
  height: 500,
  words: [
    word("A", 10, 100), word("100", 300, 100),
    word("B", 10, 120), word("200", 300, 120),
    word("C", 10, 140), word("300", 300, 140),
    // footer is outside the table bbox and must never enter a lattice row
    word("Term", 10, 200), word("Condition:", 35, 200)
  ],
  rulings: { horizontal: [], vertical: [
    { x: 0, y0: 90, y1: 155 },
    { x: 250, y0: 90, y1: 155 },
    { x: 500, y0: 90, y1: 155 }
  ] }
};

const layout = {
  mode: "lattice",
  columns: [
    { x0: 0, x1: 250 },
    { x0: 250, x1: 500 }
  ],
  grid: {
    columnLines: [0, 250, 500],
    // Only outer/header-like boundaries were detected. The separators between
    // A/B/C are intentionally absent.
    rowLines: [90, 155]
  }
};

const rows = buildRows(page, layout, {});
assert.equal(rows.length, 3, "missing thin rules must not swallow data rows");
assert.deepEqual(rows.map(r => r.cells.map(c => c?.text || "")), [
  ["A", "100"],
  ["B", "200"],
  ["C", "300"]
]);
assert.ok(rows.every(r => (r.cells || []).every(c => (c?.rowspan || 1) === 1)), "data rows must not get inferred rowspan");
assert.ok(rows.every(r => !r.cells.some(c => /Term|Condition/i.test(c?.text || ""))), "footer must not enter lattice rows");

console.log("PASS lattice row-split regression: missing colored rules no longer swallow rows or footer");
