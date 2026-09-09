import assert from 'node:assert/strict';
import { buildRows } from '../assets/lib/table.js';

function word(x0, x1, top, bottom, text) {
  return { x0, x1, top, bottom, text, vertical:false, fontSize:8, fontFamily:'' };
}

const cols = [
  {x0:0,x1:70},{x0:70,x1:130},{x0:130,x1:190},{x0:190,x1:270},
  {x0:270,x1:470},{x0:470,x1:600},{x0:600,x1:700},{x0:700,x1:840}
];
const page = {
  width: 842, height: 595,
  words: [
    word(10,55,110,120,'BRAND'), word(75,110,110,120,'TYPE'),
    word(135,170,110,120,'BODY'), word(195,250,110,120,'PRESSURE'),
    word(280,320,110,120,'DETAILS'), word(480,550,110,120,'CONNECTION'),
    word(620,650,110,120,'FIG'), word(710,800,110,120,'SIZE UNIT PRICE'),
    word(10,45,126,136,'RISER'), word(75,105,126,136,'GATE'),
    word(135,155,126,136,'CI'), word(195,230,126,136,'PN16'),
    word(280,430,126,136,'NRS METAL SEAT'), word(480,570,126,136,'FLANGE END PN16'),
    word(620,650,126,136,'929'), word(710,750,126,136,'DN50'), word(760,830,126,136,'2,557,000'),
    word(10,45,142,152,'RISER'), word(75,105,142,152,'GATE'),
    word(135,155,142,152,'CI'), word(195,230,142,152,'PN16'),
    word(280,430,142,152,'NRS METAL SEAT'), word(480,570,142,152,'FLANGE END PN16'),
    word(620,650,142,152,'929'), word(710,750,142,152,'DN65'), word(760,830,142,152,'2,984,000')
  ],
  rulings: {horizontal:[], vertical:[]}
};

const layout = {
  mode:'adaptive-horizontal',
  columns:cols,
  rowSeparators:[108,160],
  adaptive:{header:{y0:110,y1:120,groups:cols.map(c=>({...c}))}}
};

const rows = buildRows(page, layout, {});
assert.equal(rows.length, 3, 'header + DN50 + DN65 must be separate rows');
assert.match(rows[0].cells.map(c=>c?.text||'').join(' | '), /BRAND/);
assert.match(rows[1].cells.map(c=>c?.text||'').join(' | '), /DN50/);
assert.match(rows[2].cells.map(c=>c?.text||'').join(' | '), /DN65/);
assert.doesNotMatch(rows[0].cells.map(c=>c?.text||'').join(' | '), /DN50/);
assert.doesNotMatch(rows[0].cells.map(c=>c?.text||'').join(' | '), /DN65/);
console.log('PASS RISER header+first-data band regression');
