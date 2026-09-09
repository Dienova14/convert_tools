# Convert Tools

PDF to Excel converter with independent modes.

## Modes

- Adaptive Detection — stable text-layer engine.
- OCR Adaptive — experimental scan/OCR path.
- Ikuti garis border — lattice/grid detection.
- Ikuti celah spasi — stream detection.
- Catalog Detection · Multi Table — Catalog V4 structural engine.

Catalog V4 is isolated from the existing engines. It is designed for product
catalogs/pricelists where a PDF may contain multiple tables per page, repeated
or varying headers, section bands, multiline descriptions, and tables that
continue onto later pages.

Open `index.html` through a local HTTP server. Do not use `file://` because ES
modules and PDF.js workers require an HTTP origin in normal browser setups.
