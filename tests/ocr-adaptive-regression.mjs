import assert from "node:assert/strict";
import { parseOcrTsvForTest } from "../assets/lib/ocr/ocr-adapter.js";

const tsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "5\t1\t1\t1\t1\t1\t30\t40\t50\t12\t96.0\tKode",
  "5\t1\t1\t1\t1\t2\t100\t40\t80\t12\t95.0\tNama",
  "5\t1\t1\t1\t2\t1\t30\t70\t42\t12\t91.0\t00123",
  "5\t1\t1\t1\t2\t2\t100\t70\t70\t12\t90.0\tProduk"
].join("\n");

const words = parseOcrTsvForTest(tsv, 2, 400, 300);
assert.equal(words.length, 4);
assert.equal(words[0].text, "Kode");
assert.equal(words[0].x0, 15);
assert.equal(words[0].x1, 40);
assert.equal(words[0].top, 20);
assert.equal(words[0].bottom, 26);
assert.equal(words[2].text, "00123");
assert.equal(words[2].source, "ocr");
assert.equal(words[2].confidence, 91);

console.log("PASS OCR Adaptive TSV normalization");
