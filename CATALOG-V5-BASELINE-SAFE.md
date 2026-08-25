# Catalog V5 — Baseline Safe

This build prioritizes the previously approved engines.

## Protected modes
- Adaptive
- OCR Adaptive
- Lattice
- Stream
- Grouped (if enabled)

Their exporter and SheetJS dependency are restored to the baseline.

## Catalog
Catalog remains an isolated branch:
`document.js -> catalog.js`

Catalog table detection changes do not modify `table.js`, `geometry.js`, or the baseline exporter.

### Important
Catalog-specific styling is intentionally not forced through the global Excel library in this build. The next Catalog iteration should use a separate, isolated styling/export path so the baseline modes cannot be affected.

## Regression requirement
Before adding more Catalog features, verify:
1. Adaptive output is non-empty.
2. OCR Adaptive output remains unchanged.
3. Lattice/Stream remain unchanged.
4. Catalog can be tested independently.
