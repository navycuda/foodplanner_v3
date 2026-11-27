import assert from 'node:assert/strict';
import { allocateDishes, type ItemStock, type PlanNeed } from './allocate.js';

// 6 eggs. Candy is shown before dinner, so it keeps 4 and dinner is short 2.
const eggs: ItemStock = { unit: 'piece', gramsPerPiece: 60, loose: 6, packages: [] };
const eggNeeds: PlanNeed[] = [
  { entryId: 1, date: '2026-11-28', mealType: 'dinner', itemId: 1, need: 4, claimPackageId: null },
  { entryId: 2, date: '2026-11-28', mealType: 'candy', itemId: 1, need: 4, claimPackageId: null },
];
const eggTakes = allocateDishes(new Map([[1, eggs]]), eggNeeds);
const candy = eggTakes.find(take => take.entryId === 2);
const dinner = eggTakes.find(take => take.entryId === 1);
assert.equal(candy?.enough, true);
assert.equal(candy?.reserved, 4);
assert.equal(dinner?.enough, false);
assert.ok(Math.abs((dinner?.shortBy ?? 0) - 2) < 1e-9);

// Sunday is earlier than Monday, even if Monday was entered first.
const byDate = allocateDishes(new Map([[1, eggs]]), [
  { entryId: 9, date: '2026-11-30', mealType: 'dinner', itemId: 1, need: 4, claimPackageId: null },
  { entryId: 3, date: '2026-11-29', mealType: 'dinner', itemId: 1, need: 4, claimPackageId: null },
]);
assert.equal(byDate.find(take => take.entryId === 3)?.enough, true);
assert.equal(byDate.find(take => take.entryId === 9)?.enough, false);

// One thawed 850 g package is held whole. The later dish cannot use part of it.
const chicken: ItemStock = {
  unit: 'g',
  gramsPerPiece: null,
  loose: 0,
  packages: [{ id: 7, weightG: 850 }],
};
const held = allocateDishes(new Map([[2, chicken]]), [
  { entryId: 1, date: '2026-11-28', mealType: 'dinner', itemId: 2, need: 850, claimPackageId: 7 },
  { entryId: 2, date: '2026-11-28', mealType: 'lunch', itemId: 2, need: 200, claimPackageId: null },
]);
assert.deepEqual(held.find(take => take.entryId === 1)?.packageIds, [7]);
assert.equal(held.find(take => take.entryId === 1)?.reserved, 850);
assert.equal(held.find(take => take.entryId === 2)?.enough, false);
assert.equal(held.find(take => take.entryId === 2)?.packageIds.length, 0);

// 200 g loose plus an 850 g package covers a 400 g need, and the package is still whole.
const mixed: ItemStock = {
  unit: 'g',
  gramsPerPiece: null,
  loose: 200,
  packages: [{ id: 4, weightG: 850 }],
};
const covered = allocateDishes(new Map([[2, mixed]]), [
  { entryId: 1, date: '2026-11-28', mealType: 'dinner', itemId: 2, need: 400, claimPackageId: null },
]);
const take = covered[0];
assert.equal(take?.enough, true);
assert.equal(take?.takenLoose, 200);
assert.deepEqual(take?.packageIds, [4]);
assert.equal(take?.reserved, 1050);

console.log('allocation checks passed');
