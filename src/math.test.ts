import assert from 'node:assert/strict';
import {
  addIsoDays,
  averageStoreUnitPricePerG,
  compareUseFirst,
  gramsFromPieces,
  isUseSoon,
  kcalForGrams,
  latestStoreUnitPricePerG,
  scaleFactor,
  unitPricePerG,
  unitPricePerPackage,
} from './math.js';

// Worked examples from the household: store produce, a butcher box, eggs, a curry portion.

const tomatoes = { source: 'store' as const, total_price: 6, total_g: 1500, added_on: '2026-11-01', id: 1 };
const peppers = { source: 'store' as const, total_price: 30, total_g: 1000, added_on: '2026-11-20', id: 2 };
const sameDay = { source: 'store' as const, total_price: 10, total_g: 1000, added_on: '2026-11-20', id: 3 };
const meatles = { source: 'homestead' as const, total_price: null, total_g: 10200, added_on: '2026-11-15', id: 4 };

assert.equal(unitPricePerG(6, 1500), 0.004);
assert.equal(unitPricePerG(null, 10200), null);
assert.equal(unitPricePerG(12, 0), null);

// $48 for 4800 g in 6 freezer packages.
assert.equal(unitPricePerG(48, 4800), 0.01);
assert.equal(unitPricePerPackage(48, 6), 8);
assert.equal(unitPricePerPackage(null, 12), null);
assert.equal(unitPricePerPackage(48, null), null);

// 1.5 kg at $6 and 1 kg at $30. The homestead box is ignored. 36 / 2500 = 0.0144.
assert.equal(averageStoreUnitPricePerG([tomatoes, peppers, meatles]), 36 / 2500);
assert.equal(averageStoreUnitPricePerG([meatles]), null);

assert.equal(latestStoreUnitPricePerG([tomatoes, peppers, meatles]), 30 / 1000);
assert.equal(latestStoreUnitPricePerG([peppers, sameDay]), 10 / 1000);

assert.equal(gramsFromPieces(3, 60), 180);
assert.equal(kcalForGrams(180, 143), 257.4);

// 400 g of a 1000 g curry. The chicken line was 500 g at 110 kcal/100 g.
assert.equal(scaleFactor(400, 1000), 0.4);
const chickenGrams = 500 * scaleFactor(400, 1000);
assert.equal(chickenGrams, 200);
assert.equal(kcalForGrams(chickenGrams, 110), 220);

// A weighed package against the recipe's chicken line.
assert.equal(scaleFactor(852, 850), 852 / 850);
assert.throws(() => scaleFactor(400, 0));

assert.equal(addIsoDays('2026-11-27', 3), '2026-11-30');
assert.equal(addIsoDays('2026-12-30', 3), '2027-01-02');

const today = '2026-11-27';
assert.equal(isUseSoon('2026-11-26', today), true);
assert.equal(isUseSoon('2026-11-27', today), true);
assert.equal(isUseSoon('2026-11-30', today), true);
assert.equal(isUseSoon('2026-12-01', today), false);
assert.equal(isUseSoon(null, today), false);

const older = { added_on: '2026-11-01', id: 1 };
const newer = { added_on: '2026-11-20', id: 2 };
assert.ok(compareUseFirst(older, newer, 14) < 0);
assert.ok(compareUseFirst(newer, older, null) > 0);
assert.ok(compareUseFirst({ added_on: '2026-11-01', id: 5 }, { added_on: '2026-11-01', id: 2 }, 7) > 0);

console.log('math checks passed');
