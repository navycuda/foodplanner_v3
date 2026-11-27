import assert from 'node:assert/strict';
import { consumeStock, lineCost, shopQuantity, usePerDay } from './consume.js';

// Oldest lot first: 3 g, then 10 g. A 5 g need leaves 8 g on the newer lot.
const loose = consumeStock(5, [
  { id: 1, kind: 'loose', amount: 3 },
  { id: 2, kind: 'loose', amount: 10 },
]);
assert.equal(loose.consumed, 5);
assert.deepEqual(loose.looseTakes, [
  { id: 1, take: 3 },
  { id: 2, take: 2 },
]);
assert.deepEqual(loose.packageIds, []);

// A 200 g need still takes the whole 850 g package.
const frozen = consumeStock(200, [{ id: 7, kind: 'package', amount: 850 }]);
assert.equal(frozen.consumed, 850);
assert.deepEqual(frozen.packageIds, [7]);
assert.deepEqual(frozen.looseTakes, []);

// Under min, with a max: one shop that reaches max, not shortfall plus max.
assert.equal(shopQuantity(300, 0, 500, 2000), 2000);
// No max: reach min. The plan gap is already inside that.
assert.equal(shopQuantity(300, 0, 500, null), 500);
// Above min: only what the plan could not cover.
assert.equal(shopQuantity(100, 600, 500, 2000), 100);
assert.equal(shopQuantity(0, 600, 500, null), 0);

// $6 / 1500 g is $0.004/g, so 500 g is $2. Three 60 g eggs at $0.01/g are $1.80.
assert.equal(lineCost(500, 'g', null, 0.004), 2);
assert.equal(lineCost(3, 'piece', 60, 0.01), 1.8);
assert.equal(lineCost(500, 'g', null, null), null);

// 6 eggs deducted over 3 days is 2 a day.
assert.equal(usePerDay(6, '2026-11-24', '2026-11-27'), 2);

console.log('consume checks passed');
