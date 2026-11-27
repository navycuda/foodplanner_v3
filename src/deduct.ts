import { mealRank } from './allocate.js';
import { consumeStock, type StockPiece } from './consume.js';
import { all, get, type DB } from './db.js';
import { compareUseFirst, scaleFactor, todayIso, type IngredientAmount } from './math.js';
import type { MealType, Unit } from './types.js';

// Past planned dishes come off the shelf once. Running this again does nothing
// to a dish already marked deducted. A stock count can still override the lots.

type DueEntry = {
  id: number;
  date: string;
  recipe_id: number;
  quantity_g: number;
  meal_type: MealType;
  package_id: number | null;
  cooked_yield_g: number;
};

type Ingredient = IngredientAmount & {
  item_id: number;
};

type LotRow = {
  id: number;
  added_on: string;
  location: string;
  quantity: number | null;
  package_count: number | null;
};

const EPS = 1e-6;

export function deductElapsed(db: DB) {
  const today = todayIso();
  const due = all<DueEntry>(db, `
    SELECT plan_entries.id, plan_entries.date, plan_entries.recipe_id, plan_entries.quantity_g,
           plan_entries.meal_type, plan_entries.package_id, recipes.cooked_yield_g AS cooked_yield_g
    FROM plan_entries
    JOIN recipes ON recipes.id = plan_entries.recipe_id
    WHERE plan_entries.status = 'planned' AND plan_entries.date < ?
  `, today);
  due.sort((a, b) => a.date.localeCompare(b.date) || mealRank(a.meal_type) - mealRank(b.meal_type) || a.id - b.id);
  for (const entry of due) deductEntry(db, entry);
}

function deductEntry(db: DB, entry: DueEntry) {
  const factor = entry.cooked_yield_g > 0 ? scaleFactor(entry.quantity_g, entry.cooked_yield_g) : 0;
  const lines = all<Ingredient & { name: string }>(db, `
    SELECT recipe_ingredients.item_id, recipe_ingredients.quantity,
           items.unit, items.grams_per_piece AS gramsPerPiece, items.kcal_per_100g AS kcalPer100g,
           items.name
    FROM recipe_ingredients
    JOIN items ON items.id = recipe_ingredients.item_id
    WHERE recipe_ingredients.recipe_id = ?
  `, entry.recipe_id);
  const run = db.transaction(() => {
    // Still planned? A second caller may have finished it.
    const fresh = get<{ status: string }>(db, 'SELECT status FROM plan_entries WHERE id = ?', entry.id);
    if (!fresh || fresh.status !== 'planned') return;
    if (entry.package_id != null) {
      db.prepare('UPDATE plan_entries SET package_id = NULL WHERE id = ?').run(entry.id);
    }
    for (const line of lines) {
      const need = line.quantity * factor;
      const removed = takeIngredient(db, entry, line, need);
      if (removed > EPS) {
        db.prepare(`
          INSERT INTO consumption (item_id, deducted_on, quantity, plan_entry_id)
          VALUES (?, ?, ?, ?)
        `).run(line.item_id, entry.date, removed, entry.id);
      }
    }
    db.prepare(`UPDATE plan_entries SET status = 'deducted' WHERE id = ?`).run(entry.id);
  });
  run();
}

function takeIngredient(db: DB, entry: DueEntry, line: Ingredient, need: number): number {
  if (!(need > EPS)) return 0;
  const item = get<{ shelf_life_days: number | null; unit: Unit; grams_per_piece: number | null }>(db, `
    SELECT shelf_life_days, unit, grams_per_piece FROM items WHERE id = ?
  `, line.item_id);
  if (!item) return 0;
  let consumed = 0;
  let remaining = need;

  if (entry.package_id != null) {
    const explicit = packageAmount(db, entry.package_id, line.item_id, item);
    if (explicit != null) {
      db.prepare('DELETE FROM lot_packages WHERE id = ?').run(entry.package_id);
      consumed += explicit;
      remaining -= explicit;
    }
  }

  if (remaining <= EPS) return consumed;
  const pieces = stockPieces(db, line.item_id, item, entry.package_id);
  const taken = consumeStock(remaining, pieces);
  const updateLot = db.prepare('UPDATE lots SET quantity = quantity - ? WHERE id = ?');
  for (const loose of taken.looseTakes) updateLot.run(loose.take, loose.id);
  const removePackage = db.prepare('DELETE FROM lot_packages WHERE id = ?');
  for (const id of taken.packageIds) removePackage.run(id);
  return consumed + taken.consumed;
}

function packageAmount(
  db: DB,
  packageId: number,
  itemId: number,
  item: { unit: Unit; grams_per_piece: number | null },
): number | null {
  const row = get<{ weight_g: number; item_id: number }>(db, `
    SELECT lot_packages.weight_g AS weight_g, lots.item_id AS item_id
    FROM lot_packages
    JOIN lots ON lots.id = lot_packages.lot_id
    WHERE lot_packages.id = ?
  `, packageId);
  if (!row || row.item_id !== itemId) return null;
  return amountInUnit(row.weight_g, item);
}

function stockPieces(
  db: DB,
  itemId: number,
  item: { shelf_life_days: number | null; unit: Unit; grams_per_piece: number | null },
  skipPackageId: number | null,
): StockPiece[] {
  const lots = all<LotRow>(db, 'SELECT id, added_on, location, quantity, package_count FROM lots WHERE item_id = ?', itemId);
  lots.sort((a, b) => compareUseFirst(a, b, item.shelf_life_days));
  const pieces: StockPiece[] = [];
  const packageRows = all<{ id: number; lot_id: number; weight_g: number }>(db, `
    SELECT lot_packages.id, lot_packages.lot_id, lot_packages.weight_g
    FROM lot_packages
    JOIN lots ON lots.id = lot_packages.lot_id
    WHERE lots.item_id = ? AND lots.location = 'freezer'
    ORDER BY lot_packages.id
  `, itemId);
  for (const lot of lots) {
    if (lot.location === 'freezer') continue;
    const amount = lot.quantity ?? 0;
    if (amount > EPS) pieces.push({ id: lot.id, kind: 'loose', amount });
  }
  for (const lot of lots) {
    if (lot.location !== 'freezer') continue;
    for (const pkg of packageRows.filter(row => row.lot_id === lot.id)) {
      if (pkg.id === skipPackageId) continue;
      pieces.push({ id: pkg.id, kind: 'package', amount: amountInUnit(pkg.weight_g, item) });
    }
  }
  return pieces;
}

function amountInUnit(weightG: number, item: { unit: Unit; grams_per_piece: number | null }): number {
  if (item.unit === 'g') return weightG;
  if (item.grams_per_piece == null || !(item.grams_per_piece > 0)) return 0;
  return weightG / item.grams_per_piece;
}
