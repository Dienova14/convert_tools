# OCR Adaptive v0.1

Mode ini TERPISAH dari Adaptive Detection biasa.

## Alur

PDF -> PDF.js render -> Tesseract.js -> OCR words + bounding boxes -> existing Adaptive table engine -> document.js -> Excel/CSV.

OCR tidak mempunyai engine tabel sendiri. Ini sengaja supaya perbaikan Adaptive, header, continuation, rowspan, dan export tetap dipakai bersama.

## Menjalankan

Tidak perlu server OCR. Tesseract.js dijalankan di browser menggunakan Web Worker. Aplikasi memuat Tesseract.js 7.0.0 dari jsDelivr.

Pilih:

`Struktur tabel -> OCR Adaptive (PDF scan)`

Lalu pilih bahasa dan resolusi OCR.

- 2x: lebih cepat
- 3x: default/disarankan
- 4x: lebih berat tetapi biasanya lebih baik untuk scan kecil

## Catatan

- OCR memerlukan waktu lebih lama daripada PDF text biasa.
- OCR hanya membaca text + posisi; struktur tabel tetap ditentukan Adaptive.
- Confidence OCR disimpan pada page model untuk debugging.
- Mode otomatis yang menggabungkan OCR + non-OCR BELUM dibuat pada patch ini.

\n## v0.2 fix
If a scanned PDF produced "PDF ini tidak punya lapisan teks" even when OCR Adaptive
was selected, v0.2 fixes the pipeline by normalizing multi-language Tesseract input
and falling back from TSV to Tesseract structured blocks when TSV is empty.

\n## v0.4 visual grid
OCR Adaptive now detects long visual table rules from the rendered image and feeds
them into the existing ruling-aware Adaptive engine. This is intended to preserve
empty/image columns and group multi-line cells without hard-coding a catalog layout.

\n## v0.5.1
The experimental per-empty-cell OCR retry was removed because it could create
false positives. OCR Adaptive now infers columns from repeated word bands and
visual table bounds instead of fabricating OCR content in empty cells.

\n## v0.6 grid-first
The OCR path now treats the rendered table grid as the primary geometry source.
OCR supplies text inside those cells. This avoids inventing columns from sparse
OCR words and preserves image-only/empty columns.
