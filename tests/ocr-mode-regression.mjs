import assert from "node:assert/strict";
import { parseOcrTsvForTest, normalizeOcrLanguageForTest, visualGridDetectionAvailableForTest, chooseRegularSequenceForTest, inferMissingGridSeparatorsForTest } from "../assets/lib/ocr/ocr-adapter.js";

const tsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "5\t1\t1\t1\t1\t1\t40\t60\t45\t14\t97\tPART",
  "5\t1\t1\t1\t1\t2\t120\t60\t35\t14\t96\tCODE",
  "5\t1\t1\t1\t2\t1\t40\t90\t60\t14\t94\t00123"
].join("\n");

const words = parseOcrTsvForTest(tsv, 2, 500, 700);
assert.deepEqual(words.map(w => w.text), ["PART", "CODE", "00123"]);
assert.ok(words.every(w => w.source === "ocr"));
assert.ok(words.every(w => Number.isFinite(w.x0) && Number.isFinite(w.top)));

console.log("PASS OCR mode word model");

assert.deepEqual(normalizeOcrLanguageForTest("eng"), "eng");
assert.deepEqual(normalizeOcrLanguageForTest("eng+ind"), ["eng", "ind"]);
assert.deepEqual(normalizeOcrLanguageForTest(" ind + eng "), ["ind", "eng"]);
console.log("PASS OCR language normalization");

const adapterSource = await (await import("node:fs/promises")).readFile(
  new URL("../assets/lib/ocr/ocr-adapter.js", import.meta.url), "utf8"
);
assert.match(adapterSource, /\{\s*text:\s*true,\s*tsv:\s*true,\s*blocks:\s*true\s*\}/);
console.log("PASS OCR requests structured blocks");

assert.equal(visualGridDetectionAvailableForTest(), true);
console.log("PASS OCR visual grid detector");

import { inferOcrColumnModelForTest } from "../assets/lib/table.js";

const synthetic = {
  ocr: true,
  width: 465,
  height: 620,
  words: [
    {text:"Apple",x0:140,x1:175,top:120,bottom:130,confidence:90,vertical:false},
    {text:"iPhone",x0:132,x1:170,top:140,bottom:150,confidence:90,vertical:false},
    {text:"15",x0:175,x1:185,top:140,bottom:150,confidence:90,vertical:false},
    {text:"Rp14.499.000",x0:220,x1:285,top:120,bottom:130,confidence:90,vertical:false},
    {text:"Rp1",x0:350,x1:370,top:120,bottom:130,confidence:90,vertical:false},
    {text:"Segi",x0:132,x1:150,top:190,bottom:200,confidence:90,vertical:false},
    {text:"Tiga",x0:152,x1:175,top:190,bottom:200,confidence:90,vertical:false},
    {text:"Rp50.000",x0:220,x1:270,top:190,bottom:200,confidence:90,vertical:false},
    {text:"Rp1",x0:350,x1:370,top:190,bottom:200,confidence:90,vertical:false}
  ],
  rulings: {horizontal:[
    {y:80,x0:0,x1:450},{y:110,x0:0,x1:450},{y:170,x0:0,x1:450},
    {y:230,x0:0,x1:450}
  ],vertical:[]}
};
const model = inferOcrColumnModelForTest(synthetic, synthetic.rulings);
assert.ok(model && model.columns.length >= 3);
assert.equal(model.leadingEmpty, true);
console.log("PASS OCR anchor-column inference");

const selected = chooseRegularSequenceForTest(
  [47, 69, 343.5, 619.5, 896, 1170, 1192],
  1240,
  4
);
assert.deepEqual(selected.map(v => Math.round(v)), [69, 344, 620, 896, 1170]);
console.log("PASS OCR grid sequence excludes decorative border");

const completed = inferMissingGridSeparatorsForTest(
  [177, 431.5, 559, 685.5, 812.5, 938.5, 1066, 1193, 1320, 1447.5, 1595],
  [
    { text: "Nama", x0: 350, x1: 390, top: 195, bottom: 220, fontSize: 20 },
    { text: "Produk", x0: 350, x1: 405, top: 225, bottom: 250, fontSize: 20 },
    { text: "Apple", x0: 350, x1: 400, top: 330, bottom: 355, fontSize: 20 },
    { text: "iPhone", x0: 350, x1: 415, top: 360, bottom: 385, fontSize: 20 }
  ]
);
assert.ok(completed.some(v => Math.abs(v - 300) < 20));
console.log("PASS OCR grid infers missing header separator");
