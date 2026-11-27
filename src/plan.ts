import type { Express, NextFunction, Request, Response } from 'express';
import { allocateDishes, mealRank, type ItemStock, type ItemTake, type PlanNeed } from './allocate.js';
import { deductElapsed } from './deduct.js';
import { all, get, type DB } from './db.js';
import {
  batchKcal,
  expiryDate,
  ingredientGrams,
  isIsoDate,
  isUseSoon,
  scaleFactor,
  todayIso,
  type IngredientAmount,
} from './math.js';
import type { MealType, PlanDish, Unit } from './types.js';

// A planned dish holds the stock it would use. Earlier days, then Candy → Dinner →
// Breakfast → Lunch → For Stock. Past days stay on the calendar but do not hold
// stock; slice 4 deducts them and marks them cooked. Nothing here deducts.

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type EntryRow = {
  id: number;
  date: string;
  recipe_id: number;
  quantity_g: number;
  meal_type: MealType;
  status: 'planned' | 'deducted';
  package_id: number | null;
  recipe_name: string;
  cooked_yield_g: number;
};

type IngredientRow = {
  recipe_id: number;
  item_id: number;
  quantity: number;
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
};

type PackageStock = {
  id: number;
  item_id: number;
  weight_g: number;
  added_on: string;
  shelf_life_days: number | null;
  item_name: string;
};

export type ReservationSnapshot = {
  byItem: Map<number, number>;
  packageIds: Set<number>;
};

/** Uncovered need of dishes from today on, in each item's unit. */
export function planShortByItem(db: DB): Map<number, number> {
  const { takes } = loadAllocation(db);
  const map = new Map<number, number>();
  for (const take of takes) {
    if (!(take.shortBy > 1e-6)) continue;
    map.set(take.itemId, (map.get(take.itemId) ?? 0) + take.shortBy);
  }
  return map;
}

export function reservationSnapshot(db: DB): ReservationSnapshot {
  const { takes } = loadAllocation(db);
  const byItem = new Map<number, number>();
  const packageIds = new Set<number>();
  for (const take of takes) {
    byItem.set(take.itemId, (byItem.get(take.itemId) ?? 0) + take.reserved);
    for (const id of take.packageIds) packageIds.add(id);
  }
  return { byItem, packageIds };
}

export function registerPlanRoutes(app: Express, db: DB) {
  const route = (handler: (req: Request, res: Response) => void) => {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        deductElapsed(db);
        handler(req, res);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      }
    };
  };

  app.get('/api/plan', route((req, res) => {
    const from = queryDate(req.query.from, 'from');
    const to = queryDate(req.query.to, 'to');
    if (from > to) throw new HttpError(400, 'from must be on or before to.');
    res.json(dishesInRange(db, from, to));
  }));

  app.post('/api/plan', route((req, res) => {
    const body = bodyObject(req.body);
    const date = parseDate(body.date);
    if (date < todayIso()) throw new HttpError(400, 'That day has passed.');
    const recipe = mustRecipe(db, requiredNumber(body.recipe_id, 'Recipe'));
    const meal = parseMeal(body.meal_type);
    const chosen = resolvePackage(db, recipe.id, body.package_id);
    const quantityG = chosen
      ? scaledYield(recipe.cooked_yield_g, chosen.lineGrams, chosen.weightG)
      : requiredNumber(body.quantity_g, 'Cooked grams');
    if (!(quantityG > 0)) throw new HttpError(400, 'Cooked grams must be greater than zero.');
    if (chosen) assertPackageFree(db, chosen.id, null);
    const info = db.prepare(`
      INSERT INTO plan_entries (date, recipe_id, quantity_g, meal_type, status, package_id)
      VALUES (?, ?, ?, ?, 'planned', ?)
    `).run(date, recipe.id, quantityG, meal, chosen?.id ?? null);
    const id = Number(info.lastInsertRowid);
    const dish = dishesInRange(db, date, date).find(row => row.id === id);
    if (!dish) throw new HttpError(500, 'Could not read the new dish.');
    res.status(201).json(dish);
  }));

  app.put('/api/plan/:id', route((req, res) => {
    const entry = mustEntry(db, idParam(req.params.id, 'Dish'));
    assertEditable(entry);
    const body = bodyObject(req.body);
    const recipe = mustRecipe(db, entry.recipe_id);
    let quantityG = entry.quantity_g;
    let packageId = entry.package_id;
    let meal = entry.meal_type;
    if (body.meal_type != null) meal = parseMeal(body.meal_type);
    if (body.package_id != null) {
      const chosen = resolvePackage(db, recipe.id, body.package_id);
      if (!chosen) throw new HttpError(400, 'Package not found.');
      assertPackageFree(db, chosen.id, entry.id);
      packageId = chosen.id;
      quantityG = scaledYield(recipe.cooked_yield_g, chosen.lineGrams, chosen.weightG);
    } else if (body.quantity_g != null) {
      quantityG = requiredNumber(body.quantity_g, 'Cooked grams');
      if (!(quantityG > 0)) throw new HttpError(400, 'Cooked grams must be greater than zero.');
      // A typed weight replaces a thawed package.
      packageId = null;
    }
    db.prepare(`
      UPDATE plan_entries SET quantity_g = ?, meal_type = ?, package_id = ? WHERE id = ?
    `).run(quantityG, meal, packageId, entry.id);
    const dish = dishesInRange(db, entry.date, entry.date).find(row => row.id === entry.id);
    if (!dish) throw new HttpError(500, 'Could not read the dish.');
    res.json(dish);
  }));

  app.delete('/api/plan/:id', route((req, res) => {
    const entry = mustEntry(db, idParam(req.params.id, 'Dish'));
    assertEditable(entry);
    db.prepare('DELETE FROM plan_entries WHERE id = ?').run(entry.id);
    res.json({ ok: true });
  }));
}

function dishesInRange(db: DB, from: string, to: string): PlanDish[] {
  const { takes, entries, ingredients, packages, useSoon } = loadAllocation(db);
  const byEntry = new Map<number, ItemTake[]>();
  for (const take of takes) {
    const list = byEntry.get(take.entryId) ?? [];
    list.push(take);
    byEntry.set(take.entryId, list);
  }
  const shown = entries.filter(entry => entry.date >= from && entry.date <= to);
  shown.sort((a, b) => a.date.localeCompare(b.date) || mealRank(a.meal_type) - mealRank(b.meal_type) || a.id - b.id);
  return shown.map(entry => presentDish(entry, ingredients, byEntry.get(entry.id) ?? [], packages, useSoon));
}

function presentDish(
  entry: EntryRow,
  ingredients: IngredientRow[],
  takes: ItemTake[],
  packages: PackageStock[],
  useSoon: Set<number>,
): PlanDish {
  const lines = ingredients.filter(line => line.recipe_id === entry.recipe_id);
  const amounts: IngredientAmount[] = lines.map(line => ({
    quantity: line.quantity,
    unit: line.unit,
    gramsPerPiece: line.grams_per_piece,
    kcalPer100g: line.kcal_per_100g,
  }));
  const factor = entry.cooked_yield_g > 0 ? scaleFactor(entry.quantity_g, entry.cooked_yield_g) : 0;
  const today = todayIso();
  const editable = entry.status === 'planned' && entry.date >= today;
  const allocated = entry.date >= today && entry.status === 'planned';
  const shortfalls = allocated
    ? takes.filter(take => !take.enough).map(take => {
      const line = lines.find(row => row.item_id === take.itemId);
      return {
        item_id: take.itemId,
        name: line?.name ?? 'Item',
        unit: line?.unit ?? 'g',
        needed: line ? line.quantity * factor : take.shortBy,
        short_by: take.shortBy,
      };
    })
    : [];
  const heldIds = new Set(takes.flatMap(take => take.packageIds));
  const held = packages.filter(pkg => heldIds.has(pkg.id)).map(pkg => ({
    id: pkg.id,
    weight_g: pkg.weight_g,
    item_name: pkg.item_name,
  }));
  const chosen = entry.package_id == null ? null : packages.find(pkg => pkg.id === entry.package_id) ?? null;
  return {
    id: entry.id,
    date: entry.date,
    recipe_id: entry.recipe_id,
    recipe_name: entry.recipe_name,
    quantity_g: entry.quantity_g,
    meal_type: entry.meal_type,
    status: entry.status,
    editable,
    kcal: batchKcal(amounts) * factor,
    use_soon: lines.some(line => useSoon.has(line.item_id)),
    can_make: !allocated || shortfalls.length === 0,
    package: chosen ? { id: chosen.id, weight_g: chosen.weight_g, item_name: chosen.item_name } : null,
    held_packages: held,
    shortfalls,
  };
}

function loadAllocation(db: DB): {
  takes: ItemTake[];
  entries: EntryRow[];
  ingredients: IngredientRow[];
  packages: PackageStock[];
  useSoon: Set<number>;
} {
  const entries = all<EntryRow>(db, `
    SELECT plan_entries.id, plan_entries.date, plan_entries.recipe_id, plan_entries.quantity_g,
           plan_entries.meal_type, plan_entries.status, plan_entries.package_id,
           recipes.name AS recipe_name, recipes.cooked_yield_g AS cooked_yield_g
    FROM plan_entries
    JOIN recipes ON recipes.id = plan_entries.recipe_id
  `);
  const ingredients = all<IngredientRow>(db, `
    SELECT recipe_ingredients.recipe_id, recipe_ingredients.item_id, recipe_ingredients.quantity,
           items.name, items.unit, items.grams_per_piece, items.kcal_per_100g
    FROM recipe_ingredients
    JOIN items ON items.id = recipe_ingredients.item_id
  `);
  const packages = all<PackageStock>(db, `
    SELECT lot_packages.id AS id, lots.item_id AS item_id, lot_packages.weight_g AS weight_g,
           lots.added_on AS added_on, items.shelf_life_days AS shelf_life_days, items.name AS item_name
    FROM lot_packages
    JOIN lots ON lots.id = lot_packages.lot_id
    JOIN items ON items.id = lots.item_id
    WHERE lots.location = 'freezer'
  `);
  const looseRows = all<{ item_id: number; loose: number }>(db, `
    SELECT item_id, SUM(quantity) AS loose FROM lots WHERE location != 'freezer' GROUP BY item_id
  `);
  const loose = new Map(looseRows.map(row => [row.item_id, row.loose]));
  const itemRows = all<{ id: number; unit: Unit; grams_per_piece: number | null }>(db, `
    SELECT id, unit, grams_per_piece FROM items
  `);
  const today = todayIso();
  const holding = entries.filter(entry => entry.status === 'planned' && entry.date >= today);
  const itemIds = new Set<number>();
  for (const entry of holding) {
    for (const line of ingredients) if (line.recipe_id === entry.recipe_id) itemIds.add(line.item_id);
  }
  const stock = new Map<number, ItemStock>();
  for (const item of itemRows) {
    if (!itemIds.has(item.id)) continue;
    const packs = packages
      .filter(pkg => pkg.item_id === item.id)
      .sort((a, b) => {
        const expA = expiryDate(a.added_on, a.shelf_life_days);
        const expB = expiryDate(b.added_on, b.shelf_life_days);
        if (expA !== expB) {
          if (expA == null) return 1;
          if (expB == null) return -1;
          return expA < expB ? -1 : 1;
        }
        if (a.added_on !== b.added_on) return a.added_on < b.added_on ? -1 : 1;
        return a.id - b.id;
      });
    stock.set(item.id, {
      unit: item.unit,
      gramsPerPiece: item.grams_per_piece,
      loose: loose.get(item.id) ?? 0,
      packages: packs.map(pkg => ({ id: pkg.id, weightG: pkg.weight_g })),
    });
  }
  const packageItem = new Map(packages.map(pkg => [pkg.id, pkg.item_id]));
  const needs: PlanNeed[] = [];
  for (const entry of holding) {
    const factor = entry.cooked_yield_g > 0 ? entry.quantity_g / entry.cooked_yield_g : 0;
    for (const line of ingredients) {
      if (line.recipe_id !== entry.recipe_id) continue;
      const claim = entry.package_id != null && packageItem.get(entry.package_id) === line.item_id
        ? entry.package_id
        : null;
      needs.push({
        entryId: entry.id,
        date: entry.date,
        mealType: entry.meal_type,
        itemId: line.item_id,
        need: line.quantity * factor,
        claimPackageId: claim,
      });
    }
  }
  return { takes: allocateDishes(stock, needs), entries, ingredients, packages, useSoon: useSoonIds(db) };
}

function useSoonIds(db: DB): Set<number> {
  const today = todayIso();
  const rows = all<{
    id: number;
    shelf_life_days: number | null;
    added_on: string;
    location: string;
    quantity: number | null;
    packages: number;
  }>(db, `
    SELECT items.id AS id, items.shelf_life_days AS shelf_life_days, lots.added_on AS added_on,
           lots.location AS location, lots.quantity AS quantity,
           (SELECT COUNT(*) FROM lot_packages WHERE lot_id = lots.id) AS packages
    FROM items
    JOIN lots ON lots.item_id = items.id
    WHERE items.shelf_life_days IS NOT NULL
  `);
  const ids = new Set<number>();
  for (const row of rows) {
    const stocked = row.location === 'freezer' ? row.packages > 0 : (row.quantity ?? 0) > 0;
    if (!stocked) continue;
    if (isUseSoon(expiryDate(row.added_on, row.shelf_life_days), today)) ids.add(row.id);
  }
  return ids;
}

function scaledYield(cookedYieldG: number, lineGrams: number, packageWeightG: number): number {
  return cookedYieldG * scaleFactor(packageWeightG, lineGrams);
}

function resolvePackage(db: DB, recipeId: number, value: unknown): { id: number; weightG: number; lineGrams: number } | null {
  if (value == null || value === '') return null;
  const packageId = requiredNumber(value, 'Package');
  if (!Number.isInteger(packageId) || packageId <= 0) throw new HttpError(400, 'Package is not a valid id.');
  const row = get<{ id: number; weight_g: number; item_id: number }>(db, `
    SELECT lot_packages.id AS id, lot_packages.weight_g AS weight_g, lots.item_id AS item_id
    FROM lot_packages
    JOIN lots ON lots.id = lot_packages.lot_id
    WHERE lot_packages.id = ?
  `, packageId);
  if (!row) throw new HttpError(404, 'Package not found.');
  const line = get<IngredientRow>(db, `
    SELECT recipe_ingredients.recipe_id, recipe_ingredients.item_id, recipe_ingredients.quantity,
           items.name, items.unit, items.grams_per_piece, items.kcal_per_100g
    FROM recipe_ingredients
    JOIN items ON items.id = recipe_ingredients.item_id
    WHERE recipe_ingredients.recipe_id = ? AND recipe_ingredients.item_id = ?
  `, recipeId, row.item_id);
  if (!line) throw new HttpError(400, 'That package is not an ingredient in this recipe.');
  const lineGrams = ingredientGrams({
    quantity: line.quantity,
    unit: line.unit,
    gramsPerPiece: line.grams_per_piece,
    kcalPer100g: line.kcal_per_100g,
  });
  if (!(lineGrams > 0)) throw new HttpError(400, 'That ingredient has no weight to scale from.');
  return { id: row.id, weightG: row.weight_g, lineGrams };
}

function assertPackageFree(db: DB, packageId: number, exceptEntryId: number | null) {
  const today = todayIso();
  const rows = all<{ id: number }>(db, `
    SELECT id FROM plan_entries
    WHERE package_id = ? AND status = 'planned' AND date >= ?
  `, packageId, today);
  if (rows.some(row => row.id !== exceptEntryId)) {
    throw new HttpError(409, 'That package is already on a planned dish.');
  }
}

function assertEditable(entry: EntryRow) {
  if (entry.status !== 'planned') throw new HttpError(409, 'That dish has already been cooked.');
  if (entry.date < todayIso()) throw new HttpError(409, 'That day has passed.');
}

function mustEntry(db: DB, id: number): EntryRow {
  const entry = get<EntryRow>(db, `
    SELECT plan_entries.id, plan_entries.date, plan_entries.recipe_id, plan_entries.quantity_g,
           plan_entries.meal_type, plan_entries.status, plan_entries.package_id,
           recipes.name AS recipe_name, recipes.cooked_yield_g AS cooked_yield_g
    FROM plan_entries
    JOIN recipes ON recipes.id = plan_entries.recipe_id
    WHERE plan_entries.id = ?
  `, id);
  if (!entry) throw new HttpError(404, 'Dish not found.');
  return entry;
}

function mustRecipe(db: DB, id: number): { id: number; cooked_yield_g: number } {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Recipe is not a valid id.');
  const recipe = get<{ id: number; cooked_yield_g: number }>(db, 'SELECT id, cooked_yield_g FROM recipes WHERE id = ?', id);
  if (!recipe) throw new HttpError(404, 'Recipe not found.');
  return recipe;
}

function parseMeal(value: unknown): MealType {
  if (value === 'candy' || value === 'dinner' || value === 'breakfast' || value === 'lunch' || value === 'for_stock') {
    return value;
  }
  throw new HttpError(400, 'Meal must be candy, dinner, breakfast, lunch, or for_stock.');
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !isIsoDate(value)) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
  return value;
}

function queryDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isIsoDate(value)) throw new HttpError(400, `${label} must be YYYY-MM-DD.`);
  return value;
}

function idParam(value: string | string[] | undefined, label: string): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} is not a valid id.`);
  return id;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object.');
  return body as Record<string, unknown>;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a number.`);
  return value;
}
