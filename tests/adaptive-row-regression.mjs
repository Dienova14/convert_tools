import assert from "node:assert/strict";
import { analyzePage, buildRows } from "../assets/lib/table.js";

const FONT = 10;
function word(text, x, top, { width = null, bold = false } = {}) {
  const w = width ?? text.length * 5.2;
  return {
    text,
    x0: x,
    x1: x + w,
    top,
    bottom: top + FONT,
    fontSize: FONT,
    fontFamily: bold ? "Helvetica-Bold" : "Helvetica",
    vertical: false
  };
}

const page = {
  pageNumber: 1,
  width: 595,
  height: 842,
  hasText: true,
  words: [
    word("Kode", 50, 50, { bold: true }),
    word("Nama", 170, 50, { bold: true }),
    word("Qty", 360, 50, { bold: true }),
    word("Harga", 460, 50, { bold: true }),

    word("A001", 50, 72),
    word("Produk A", 170, 72),
    word("2", 360, 72),
    word("100.000", 460, 72),

    // Valid standalone row: first field/qty are empty.
    word("Produk B", 170, 92),
    word("150.000", 460, 92),

    word("A003", 50, 112),
    word("Produk C", 170, 112),
    word("1", 360, 112),
    word("80.000", 460, 112),

    // Outside-table footer after a large vertical gap.
    word("Telp: 021-999999 Total", 50, 180),
    word("15.000.000", 360, 180)
  ],
  rulings: { horizontal: [], vertical: [] }
};

for (const mode of ["adaptive", "stream"]) {
  const layout = analyzePage(page, { mode });
  const rows = buildRows(page, layout, { joinWrapped: true });
  const values = rows.map(row => row.cells.map(cell => cell?.text || ""));

  assert.equal(values.length, 3, `${mode}: footer or row was incorrectly retained/merged`);
  assert.deepEqual(values[1], ["", "Produk B", "", "150.000"], `${mode}: standalone sparse row was swallowed`);
  assert.ok(!values.flat().some(value => value.includes("Telp")), `${mode}: footer leaked into table`);
}

console.log("PASS adaptive row boundary regression: sparse rows preserved, footer removed");
