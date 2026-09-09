import assert from 'node:assert/strict';
import { analyzePage, buildRows } from '../assets/lib/table.js';

function word(x0, x1, top, bottom, text) {
  return { x0, x1, top, bottom, text, vertical: false, fontSize: 11.88, fontFamily: '' };
}

const page = {
  pageNumber: 1,
  width: 842,
  height: 595,
  hasText: true,
  words: [
    word(20, 55, 110, 125, 'BRAND'),
    word(85, 110, 110, 125, 'TYPE'),
    word(150, 178, 110, 125, 'BODY'),
    word(213, 265, 110, 125, 'PRESSURE'),
    word(285, 325, 110, 125, 'DETAILS'),
    word(473, 542, 110, 125, 'CONNECTION'),
    word(583, 600, 110, 125, 'FIG'),
    word(648, 669, 110, 125, 'SIZE'),
    word(730, 785, 110, 125, 'UNIT PRICE'),
    ...[126, 141, 156].flatMap((y, i) => [
      word(20, 48, y, y + 14, 'RISER'),
      word(84, 109, y, y + 14, 'GATE'),
      word(148, 160, y, y + 14, 'CI'),
      word(213, 239, y, y + 14, 'PN16'),
      word(285, 450, y, y + 14, 'NRS METAL SEAT WITH INDICATOR'),
      word(473, 563, y, y + 14, 'FLANGE END PN16'),
      word(625, 710, y, y + 14, `929 DN${50 + i * 15} / 2”`),
      word(765, 813, y, y + 14, `${i + 1},000,000`)
    ])
  ],
  rulings: {
    horizontal: Array.from({ length: 5 }, (_, i) => ({ y: 109 + i * 15, x0: 18, x1: 818 })),
    vertical: [{ x: 16, y0: 109, y1: 184 }, { x: 820, y0: 109, y1: 184 }]
  }
};

const layout = analyzePage(page, { mode: 'adaptive' });
assert.equal(layout.mode, 'adaptive-horizontal');
const rows = buildRows(page, layout, { joinWrapped: true });
assert.equal(rows.length, 4); // header + 3 independent data rows
assert.match(rows[1].cells.map(c => c?.text || '').join(' | '), /DN50/);
assert.match(rows[2].cells.map(c => c?.text || '').join(' | '), /DN65/);
assert.match(rows[3].cells.map(c => c?.text || '').join(' | '), /DN80/);
console.log('PASS RISER horizontal-rule row regression: adjacent rows stay independent');
