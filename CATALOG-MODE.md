# Catalog Detection V4

Catalog V4 is a separate structural engine. Existing Adaptive, OCR Adaptive,
Lattice, Stream, and Grouped paths are left unchanged.

## What V4 does

- detects more than one physical table on a page;
- detects headers without a vendor/category name list;
- preserves title/section bands as structural rows;
- joins continuation pages when the schema/row sequence indicates the same table;
- handles continuation pages that contain only leftover rows and no header;
- keeps multiline cell text inside its detected row/cell;
- infers generic header merges from occupied/empty cells instead of fixed
  coordinates;
- exports each logical table to its own worksheet;
- uses generic Excel styling, borders, wrapping, column widths, and row heights.

## Benchmark cases

The current benchmark set includes:

1. Prabawa pricelist: multi-section tables with merged headers and continuation.
2. MONOTARO Bosch July 2026: multiple tables on one page, different schemas,
   multiline descriptions, and continuation pages (for example Bulb & Halogen
   page 10 -> 11 and Brake Pad page 12 -> 13).

## Important limitation

PDFs can encode visual color fills as graphics rather than text properties.
Catalog V4 therefore infers structural roles and applies a consistent Excel
style; it does not claim to reproduce arbitrary source-PDF RGB colors exactly.
