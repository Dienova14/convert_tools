import { buildDocumentTable, parseNumber } from "../assets/lib/document.js";
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

// Kolom di x = 50, 150, 330, 430 (rata kiri kecuali angka rata kanan-ish)
function makePage(pageNumber, rows, { withHeader = true } = {}) {
  const words = [];
  let y = 60;

  if (withHeader) {
    words.push(
      word("Kode", 50, y, { bold: true }),
      word("Nama Barang", 150, y, { bold: true }),
      word("Qty", 330, y, { bold: true }),
      word("Harga", 430, y, { bold: true })
    );
    y += 22;
  }

  for (const row of rows) {
    if (row.kode) words.push(word(row.kode, 50, y));
    if (row.nama) words.push(word(row.nama, 150, y));
    if (row.qty) words.push(word(row.qty, 330, y));
    if (row.harga) words.push(word(row.harga, 430, y));
    y += row.wrap ? 14 : 20;

    if (row.wrap) {
      words.push(word(row.wrap, 150, y));
      y += 20;
    }
  }

  return {
    pageNumber,
    width: 595,
    height: 842,
    hasText: true,
    words,
    rulings: { horizontal: [], vertical: [] }
  };
}

const page1 = makePage(1, [
  { kode: "A-001", nama: "Kabel HDMI", qty: "12", harga: "150.000" },
  { kode: "A-002", nama: "Adaptor 65W merek", qty: "4", harga: "1.250.000", wrap: "generik tipe C" },
  { kode: "A-003", nama: "Mouse", qty: "20", harga: "95.500" }
]);

// Halaman 2: header TIDAK dicetak ulang (kasus yang diminta)
const page2 = makePage(
  2,
  [
    { kode: "A-004", nama: "Keyboard", qty: "7", harga: "320.000" },
    { kode: "A-005", nama: "Monitor", qty: "2", harga: "2.100.000" }
  ],
  { withHeader: false }
);

const result = buildDocumentTable([page1, page2], {
  mode: "auto",
  headerMode: "auto",
  mergeMode: "fill",
  joinWrapped: true,
  joinAcrossPages: true
});

console.log("mode      :", result.modes.join(", "));
console.log("kolom     :", result.columnCount);
console.log("header    :", result.header ? result.header.cells.map(c => c.text) : "(tidak terdeteksi)");
console.log("baris     :", result.rows.length);
for (const row of result.rows) {
  console.log("  ", row.page, JSON.stringify(row.cells.map(c => c.text)));
}

console.log("\nparseNumber:");
for (const sample of ["150.000", "1.250.000", "1.234,56", "1,234.56", "(2.500)", "12,5%", "A-001", "3.14"]) {
  console.log(`  ${sample.padEnd(12)} -> ${parseNumber(sample, "auto")}`);
}


console.log("\nleading-zero regression:");
const leadingZeroCases = [
  ["00123", null],
  ["00045", null],
  ["012345", null],
  ["123", 123],
  ["0", 0],
  ["10", 10],
  ["1.250.000", 1250000],
  ["1.234,56", 1234.56],
  ["A-001", null]
];

for (const [sample, expected] of leadingZeroCases) {
  const actual = parseNumber(sample, "auto");
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? "PASS" : "FAIL"} ${sample.padEnd(12)} -> ${actual} (expected ${expected})`);
  if (!ok) process.exitCode = 1;
}


console.log("\nAdaptive Column Detection v1:");
const adaptivePage = {
  pageNumber: 1,
  width: 595,
  height: 842,
  hasText: true,
  words: [
    word("Kode", 50, 50, { bold: true }),
    word("Nama Barang", 145, 50, { bold: true }),
    word("Qty", 390, 50, { bold: true }),
    word("Harga", 455, 50, { bold: true }),
    word("00123", 50, 70),
    word("Kabel HDMI 2.0 3 Meter", 145, 70),
    word("10", 390, 70),
    word("150.000", 455, 70),
    word("00124", 50, 90),
    word("Mouse Wireless Logitech", 145, 90),
    word("5", 390, 90),
    word("95.000", 455, 90),
    word("00125", 50, 110),
    word("Keyboard Mechanical", 145, 110),
    word("7", 390, 110),
    word("320.000", 455, 110)
  ],
  rulings: { horizontal: [], vertical: [] }
};

const adaptiveResult = buildDocumentTable([adaptivePage], {
  mode: "adaptive",
  headerMode: "auto",
  mergeMode: "fill",
  joinWrapped: true,
  joinAcrossPages: true
});

const adaptiveHeader = adaptiveResult.header?.cells.map(cell => cell.text).join("|");
const adaptiveFirst = adaptiveResult.rows[0]?.cells.map(cell => cell.text).join("|");
const adaptiveOk =
  adaptiveResult.columnCount === 4 &&
  adaptiveHeader === "Kode|Nama Barang|Qty|Harga" &&
  adaptiveFirst === "00123|Kabel HDMI 2.0 3 Meter|10|150.000" &&
  Number.isFinite(adaptiveResult.confidence);

console.log(`  ${adaptiveOk ? "PASS" : "FAIL"} adaptive: ${adaptiveHeader} / ${adaptiveFirst} / confidence=${adaptiveResult.confidence}`);
if (!adaptiveOk) process.exitCode = 1;


console.log("\nAdaptive ruling-aware regression:");
const boundaries = [50, 80, 250, 290, 320, 350, 410, 470, 540, 590];
const rulingWords = [
  word("NO", 58, 50, { bold: true }),
  word("PELUMAS", 130, 50, { bold: true }),
  word("QTY", 260, 50, { bold: true }),
  word("KEMASAN", 355, 50, { bold: true }),
  word("BOTOL", 420, 50, { bold: true }),
  word("DOS", 480, 50, { bold: true }),
  word("REKOMENDASI", 545, 50, { bold: true }),
  word("1", 60, 70), word("ENDURO RACING 10W-60", 90, 70),
  word("6", 260, 70), word("X", 295, 70), word("1", 325, 70),
  word("LITER", 355, 70), word("216,600", 420, 70),
  word("1,299,600", 480, 70), word("289,800", 545, 70),
  word("2", 60, 90), word("ENDURO PLATINUM 5W-40", 90, 90),
  word("6", 260, 90), word("X", 295, 90), word("1", 325, 90),
  word("LITER", 355, 90), word("230,500", 420, 90),
  word("1,383,000", 480, 90), word("395,000", 545, 90)
];

const horizontal = [50, 65, 80, 95, 110].map(y => ({ y, x0: 50, x1: 590 }));
const vertical = boundaries.map(x => ({ x, y0: 50, y1: 110 }));
// Boundary NO | PELUMAS sengaja diputus menjadi beberapa segment.
vertical.splice(1, 1,
  { x: 80, y0: 50, y1: 75 },
  { x: 80, y0: 78, y1: 110 }
);

const rulingPage = {
  pageNumber: 1,
  width: 595,
  height: 842,
  hasText: true,
  words: rulingWords,
  rulings: { horizontal, vertical }
};

const rulingLayout = analyzePage(rulingPage, { mode: "adaptive" });
const rulingRows = buildRows(rulingPage, rulingLayout, { joinWrapped: true });
const rulingFirst = rulingRows.find(row => row.cells.some(cell => cell?.text === "1"));
const rulingValues = rulingFirst?.cells.map(cell => cell?.text || "");
const rulingOk =
  rulingLayout.mode === "adaptive-lattice" &&
  rulingLayout.columns.length === 9 &&
  rulingValues?.slice(0, 9).join("|") ===
    "1|ENDURO RACING 10W-60|6|X|1|LITER|216,600|1,299,600|289,800";

console.log(`  ${rulingOk ? "PASS" : "FAIL"} mode=${rulingLayout.mode} columns=${rulingLayout.columns?.length} first=${rulingValues?.join("|")}`);
if (!rulingOk) process.exitCode = 1;

console.log("\nAdaptive v1.2 ruling-stream / 10-column regression:");
const tenBoundaries = [40, 70, 125, 180, 235, 395, 435, 470, 505, 540, 575];
const tenWords = [
  word("Bosch PN", 82, 50, { bold: true }),
  word("Type", 135, 50, { bold: true }),
  word("NEW PN", 190, 50, { bold: true }),
  word("Cabin Filter Type", 245, 50, { bold: true }),
  word("Application", 300, 50, { bold: true }),
  word("HET", 405, 50, { bold: true }),
  word("<=10", 440, 50, { bold: true }),
  word("11-49", 475, 50, { bold: true }),
  word(">=50", 510, 50, { bold: true }),
  word(">=75", 545, 50, { bold: true }),
  word("0986AF4047", 45, 75), word("Standard", 80, 75), word("Standard", 190, 75),
  word("Fortuner Gen1", 245, 75), word("69.500", 400, 75), word("48.650", 440, 75),
  word("47.191", 475, 75), word("45.731", 510, 75), word("44.272", 545, 75),
  word("2.5 DE", 245, 88)
];
const tenVertical = tenBoundaries.map(x => ({x, y0: 45, y1: 110}));
const tenHorizontal = [45, 65, 110].map(y => ({y, x0: 40, x1: 575}));
const tenPage = {pageNumber: 1,width:595,height:842,hasText:true,words:tenWords,rulings:{horizontal:tenHorizontal,vertical:tenVertical}};
const tenLayout = analyzePage(tenPage, {mode:"adaptive"});
const tenRows = buildRows(tenPage, tenLayout, {joinWrapped:true});
const tenOk = tenLayout.columns?.length === 10 && tenRows.length > 0;
console.log(`  ${tenOk ? "PASS" : "FAIL"} mode=${tenLayout.mode} columns=${tenLayout.columns?.length} rows=${tenRows.length}`);
if (!tenOk) process.exitCode = 1;

console.log("\nContinuation-page regression:");
const contPrev = {
  pageNumber: 1, width: 595, height: 842, hasText: true,
  words: [word("No",50,50,{bold:true}),word("PN",150,50,{bold:true}),word("Nama",300,50,{bold:true}),word("HET",500,50,{bold:true}),
          word("41",50,75),word("ABC123",150,75),word("Produk",300,75),word("100.000",500,75)],
  rulings:{horizontal:[{y:45,x0:40,x1:570},{y:65,x0:40,x1:570},{y:90,x0:40,x1:570}],vertical:[50,150,300,500,570].map(x=>({x,y0:45,y1:90}))}
};
const contPage = {
  pageNumber: 2, width: 595, height: 842, hasText: true,
  words: [word("42",50,50),word("DEF456",150,50),word("Produk Lanjutan",300,50),word("120.000",500,50)],
  rulings:{horizontal:[],vertical:[]}
};
const contResult = buildDocumentTable([contPrev,contPage], {mode:"adaptive",headerMode:"none",mergeMode:"fill",joinWrapped:true,joinAcrossPages:true});
const contRow = contResult.rows.find(row => row.cells[0]?.text === "42");
const contOk = Boolean(contRow) && contRow.cells[3]?.text === "120.000";
console.log(`  ${contOk ? "PASS" : "FAIL"} rows=${contResult.rows.length} continuation=${contRow?.cells.map(c=>c.text).join("|")}`);
if (!contOk) process.exitCode = 1;

console.log("\nPer-page column geometry regression:");
const pageA = makePage(1, [{ kode: "A-001", nama: "Produk A", qty: "6", harga: "150.000" }]);
const pageB = {
  pageNumber: 2,
  width: 595,
  height: 842,
  hasText: true,
  words: [
    word("No", 40, 60, { bold: true }),
    word("PN", 90, 60, { bold: true }),
    word("Deskripsi", 260, 60, { bold: true }),
    word("Harga", 500, 60, { bold: true }),
    word("1", 45, 85),
    word("B-001", 100, 85),
    word("Produk B", 220, 85),
    word("220.000", 500, 85)
  ],
  rulings: {
    horizontal: [50, 70, 100].map(y => ({ y, x0: 40, x1: 550 })),
    vertical: [40, 90, 200, 400, 550].map(x => ({ x, y0: 50, y1: 100 }))
  }
};
const perPage = buildDocumentTable([pageA, pageB], {
  mode: "adaptive",
  headerMode: "none",
  mergeMode: "fill",
  joinWrapped: true,
  joinAcrossPages: true
});
const bRow = [...perPage.rows].reverse().find(row => row.page === 2);
const perPageOk = bRow?.cells.slice(0, 4).map(c => c.text).join("|") === "1|B-001|Produk B|220.000";
console.log(`  ${perPageOk ? "PASS" : "FAIL"} page2=${bRow?.cells.map(c => c.text).join("|")}`);
if (!perPageOk) process.exitCode = 1;


console.log("\nUniversal header recovery regression:");
const genericHeaderPage = {
  pageNumber: 1,
  width: 595,
  height: 842,
  hasText: true,
  words: [
    word("Item Code", 50, 50, { bold: true }),
    word("Material", 170, 50, { bold: true }),
    word("Dimension", 320, 50, { bold: true }),
    word("Unit Price", 470, 50, { bold: true }),
    word("A001", 50, 72),
    word("Steel Rod", 170, 72),
    word("10 mm", 320, 72),
    word("125.000", 470, 72),
    word("A002", 50, 92),
    word("Copper Rod", 170, 92),
    word("12 mm", 320, 92),
    word("145.000", 470, 92)
  ],
  rulings: { horizontal: [], vertical: [] }
};
const genericLayout = analyzePage(genericHeaderPage, { mode: "adaptive" });
const genericResult = buildDocumentTable([genericHeaderPage], {
  mode: "adaptive",
  headerMode: "auto",
  mergeMode: "fill",
  joinWrapped: true,
  joinAcrossPages: true
});
const genericHeader = genericResult.header?.cells.map(c => c.text).join("|");
console.log(`  header=${genericHeader || "(none)"}, columns=${genericResult.columnCount}, mode=${genericLayout.mode}`);
if (genericHeader !== "Item Code|Material|Dimension|Unit Price") process.exitCode = 1;

console.log("\nLeading-zero decimal regression:");
for (const sample of ["01.5", "00123.00", "000.5", "0.5", "10.5"]) {
  console.log(`  ${sample.padEnd(10)} -> ${parseNumber(sample, "auto")}`);
}
if (parseNumber("01.5", "auto") !== null) process.exitCode = 1;
if (parseNumber("00123.00", "auto") !== null) process.exitCode = 1;
if (parseNumber("0.5", "auto") !== 0.5) process.exitCode = 1;
