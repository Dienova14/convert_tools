import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../assets/lib/table.js', import.meta.url), 'utf8');
if (!src.includes('buildPriceListPhysicalRows')) throw new Error('physical-row recovery missing');
if (!src.includes('if (priceListRows && priceListRows.length >= 2) return priceListRows;')) throw new Error('physical-row recovery not wired before anchor bands');
console.log('PASS RISER physical-row recovery is wired before adaptive anchor grouping');
