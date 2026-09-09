# Tests

Folder ini berisi regression/smoke tests untuk menjaga perubahan baru tidak merusak engine yang sudah stabil.

- `smoke.mjs` — smoke/regression dasar Adaptive.
- `header-regression.mjs` — sanity check modul header/document.
- `ocr-adaptive-regression.mjs` — normalisasi TSV OCR ke Page Model.
- `ocr-mode-regression.mjs` — sanity check model word OCR.

Test OCR yang membutuhkan browser/Tesseract.js tidak dijalankan di Node. Test Node hanya memeriksa adapter normalization; OCR runtime diuji dari browser dengan mode `OCR Adaptive`.

\n### OCR manual fixture
`fixtures/pricelist-test-image-only.pdf` is an image-only one-page PDF.
Use it manually with `OCR Adaptive`; it is expected to work without a PDF text layer.


### OCR Adaptive v0.6 fixture expectation
For `fixtures/pricelist-test-image-only.pdf`, the visual grid should resolve to
4 columns and 11 table row bands (header + 10 products). The first column is
allowed to contain no OCR text because it is image-only.

### Lattice rowspan regression
`lattice-rowspan-regression.mjs` memastikan baris data tidak ditelan menjadi `rowspan` ketika garis horizontal tabel gagal terbaca tetapi teks pada baris berikutnya tetap ada.
