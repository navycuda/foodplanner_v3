import type { Express, NextFunction, Request, Response } from 'express';
import { all, get, type DB } from './db.js';
import { itemSummaries } from './items.js';
import {
  batchKcal,
  cookedKcalPer100g,
  ingredientGrams,
  scaleFactor,
  type IngredientAmount,
} from './math.js';
import type {
  ItemSummary,
  RecipeDetail,
  RecipeIngredient,
  RecipePortion,
  RecipeSummary,
  Unit,
} from './types.js';

// A recipe is the batch as it was made: raw ingredient amounts, plus the cooked
// weight Shane or Bella typed. A portion is that batch times requested / yield.
// A side dish is its own recipe. Nothing here writes stock; the plan slice does.

const EPS = 1e-6;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type RecipeRow = {
  id: number;
  name: string;
  cooked_yield_g: number;
  notes: string | null;
};

type IngredientRow = {
  id: number;
  recipe_id: number;
  item_id: number;
  quantity: number;
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
};

export function registerRecipeRoutes(app: Express, db: DB) {
  const route = (handler: (req: Request, res: Response) => void) => {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        handler(req, res);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        if (isSqliteConstraint(err)) {
          res.status(400).json({ error: 'That does not fit the recipe rules.' });
          return;
        }
        next(err);
      }
    };
  };

  app.get('/api/recipes', route((_req, res) => {
    const recipes = all<RecipeRow>(db, 'SELECT * FROM recipes ORDER BY name COLLATE NOCASE, id');
    const stock = stockById(db);
    const listed: RecipeSummary[] = recipes.map(recipe => {
      const lines = ingredientsOf(db, recipe.id);
      const { portion: _portion, ...summary } = summarize(recipe, lines, stock, null);
      return summary;
    });
    res.json(listed);
  }));

  app.post('/api/recipes', route((req, res) => {
    const input = parseRecipe(db, bodyObject(req.body));
    const id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO recipes (name, cooked_yield_g, notes) VALUES (@name, @cooked_yield_g, @notes)
      `).run({ name: input.name, cooked_yield_g: input.cookedYieldG, notes: input.notes });
      const recipeId = Number(info.lastInsertRowid);
      insertIngredients(db, recipeId, input.ingredients);
      return recipeId;
    })();
    res.status(201).json(present(db, mustRecipe(db, id), null));
  }));

  app.get('/api/recipes/:id', route((req, res) => {
    const recipe = mustRecipe(db, idParam(req.params.id, 'Recipe'));
    res.json(present(db, recipe, scaleRequest(db, recipe, req.query.quantity_g, req.query.package_id)));
  }));

  app.put('/api/recipes/:id', route((req, res) => {
    const recipe = mustRecipe(db, idParam(req.params.id, 'Recipe'));
    const input = parseRecipe(db, bodyObject(req.body));
    db.transaction(() => {
      db.prepare('UPDATE recipes SET name = ?, cooked_yield_g = ?, notes = ? WHERE id = ?')
        .run(input.name, input.cookedYieldG, input.notes, recipe.id);
      db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipe.id);
      insertIngredients(db, recipe.id, input.ingredients);
    })();
    res.json(present(db, mustRecipe(db, recipe.id), null));
  }));

  app.delete('/api/recipes/:id', route((req, res) => {
    const recipe = mustRecipe(db, idParam(req.params.id, 'Recipe'));
    const planned = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM plan_entries WHERE recipe_id = ?', recipe.id);
    if ((planned?.n ?? 0) > 0) throw new HttpError(409, 'This recipe is on the meal plan. Take it off the day first.');
    db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.id);
    res.json({ ok: true });
  }));
}

type ScaleRequest = {
  quantityG: number;
  packageId: number | null;
  packageWeightG: number | null;
};

function present(db: DB, recipe: RecipeRow, scale: ScaleRequest | null): RecipeDetail {
  const lines = ingredientsOf(db, recipe.id);
  const stock = stockById(db);
  const summary = summarize(recipe, lines, stock, scale);
  const packages = packagesForItems(db, lines.map(line => line.item_id));
  const ingredients: RecipeIngredient[] = lines.map(line => {
    const grams = gramsOf(line);
    const item = stock.get(line.item_id);
    return {
      id: line.id,
      item_id: line.item_id,
      name: line.name,
      unit: line.unit,
      grams_per_piece: line.grams_per_piece,
      quantity: line.quantity,
      grams,
      kcal: lineKcal(line),
      kcal_per_100g: line.kcal_per_100g,
      ww_percent: grams / recipe.cooked_yield_g * 100,
      use_soon: item?.use_soon ?? false,
      available: item?.available ?? 0,
      freezer_packages: distinctWeights(packages.get(line.item_id) ?? []),
    };
  });
  return { ...summary, ingredients };
}

function summarize(
  recipe: RecipeRow,
  lines: IngredientRow[],
  stock: Map<number, ItemSummary>,
  scale: ScaleRequest | null,
): RecipeSummary & { portion: RecipePortion } {
  const amounts = lines.map(toAmount);
  const total = batchKcal(amounts);
  const per100 = lines.length === 0 ? 0 : cookedKcalPer100g(total, recipe.cooked_yield_g);
  const useSoon = lines.some(line => stock.get(line.item_id)?.use_soon ?? false);

  const quantityG = scale?.quantityG ?? recipe.cooked_yield_g;
  const factor = scaleFactor(quantityG, recipe.cooked_yield_g);
  const portionLines = lines.map(line => {
    const quantity = line.quantity * factor;
    const available = stock.get(line.item_id)?.available ?? 0;
    const grams = gramsOf(line) * factor;
    return {
      item_id: line.item_id,
      name: line.name,
      unit: line.unit,
      quantity,
      grams,
      kcal: lineKcal(line) * factor,
      available,
      enough: quantity <= available + EPS,
    };
  });
  const shortfalls = portionLines.filter(line => !line.enough).map(line => ({
    item_id: line.item_id,
    name: line.name,
    unit: line.unit,
    needed: line.quantity,
    available: line.available,
    short_by: line.quantity - line.available,
  }));
  const portion: RecipePortion = {
    quantity_g: quantityG,
    kcal: total * factor,
    scale: factor,
    package_id: scale?.packageId ?? null,
    package_weight_g: scale?.packageWeightG ?? null,
    can_make: shortfalls.length === 0,
    lines: portionLines,
    shortfalls,
  };
  // The list flag is the batch as written. A smaller ask is `portion.can_make`.
  const batchCanMake = lines.every(line => line.quantity <= (stock.get(line.item_id)?.available ?? 0) + EPS);
  return {
    id: recipe.id,
    name: recipe.name,
    cooked_yield_g: recipe.cooked_yield_g,
    notes: recipe.notes,
    kcal: total,
    kcal_per_100g: per100,
    use_soon: useSoon,
    can_make: batchCanMake,
    portion,
  };
}

function scaleRequest(db: DB, recipe: RecipeRow, quantityValue: unknown, packageValue: unknown): ScaleRequest | null {
  const hasQuantity = quantityValue != null && quantityValue !== '';
  const hasPackage = packageValue != null && packageValue !== '';
  if (hasQuantity && hasPackage) {
    throw new HttpError(400, 'Ask for a cooked weight or a package, not both.');
  }
  if (!hasQuantity && !hasPackage) return null;
  if (hasPackage) {
    const packageId = idParam(typeof packageValue === 'string' ? packageValue : undefined, 'Package');
    const row = get<{ id: number; weight_g: number; item_id: number }>(db, `
      SELECT lot_packages.id AS id, lot_packages.weight_g AS weight_g, lots.item_id AS item_id
      FROM lot_packages
      JOIN lots ON lots.id = lot_packages.lot_id
      WHERE lot_packages.id = ?
    `, packageId);
    if (!row) throw new HttpError(404, 'Package not found.');
    const line = ingredientsOf(db, recipe.id).find(ingredient => ingredient.item_id === row.item_id);
    if (!line) throw new HttpError(400, 'That package is not an ingredient in this recipe.');
    const lineG = gramsOf(line);
    if (!(lineG > 0)) throw new HttpError(400, 'That ingredient has no weight to scale from.');
    // The package becomes the ingredient line, and the cooked yield follows.
    return {
      quantityG: recipe.cooked_yield_g * scaleFactor(row.weight_g, lineG),
      packageId: row.id,
      packageWeightG: row.weight_g,
    };
  }
  const raw = typeof quantityValue === 'string' ? Number(quantityValue) : NaN;
  if (!Number.isFinite(raw) || !(raw > 0)) throw new HttpError(400, 'quantity_g must be a number of grams greater than zero.');
  return { quantityG: raw, packageId: null, packageWeightG: null };
}

function ingredientsOf(db: DB, recipeId: number): IngredientRow[] {
  return all<IngredientRow>(db, `
    SELECT recipe_ingredients.id, recipe_ingredients.recipe_id, recipe_ingredients.item_id,
           recipe_ingredients.quantity, items.name, items.unit, items.grams_per_piece, items.kcal_per_100g
    FROM recipe_ingredients
    JOIN items ON items.id = recipe_ingredients.item_id
    WHERE recipe_ingredients.recipe_id = ?
    ORDER BY recipe_ingredients.id
  `, recipeId);
}

function packagesForItems(db: DB, itemIds: number[]): Map<number, Array<{ id: number; weight_g: number }>> {
  const grouped = new Map<number, Array<{ id: number; weight_g: number }>>();
  if (itemIds.length === 0) return grouped;
  const marks = itemIds.map(() => '?').join(',');
  const rows = all<{ id: number; weight_g: number; item_id: number }>(db, `
    SELECT lot_packages.id AS id, lot_packages.weight_g AS weight_g, lots.item_id AS item_id
    FROM lot_packages
    JOIN lots ON lots.id = lot_packages.lot_id
    WHERE lots.location = 'freezer' AND lots.item_id IN (${marks})
    ORDER BY lot_packages.id
  `, ...itemIds);
  for (const row of rows) {
    const list = grouped.get(row.item_id) ?? [];
    list.push({ id: row.id, weight_g: row.weight_g });
    grouped.set(row.item_id, list);
  }
  return grouped;
}

/** One option per weight. Ten packages at 850 g do not need ten identical choices. */
function distinctWeights(rows: Array<{ id: number; weight_g: number }>): Array<{ id: number; weight_g: number }> {
  const seen = new Set<number>();
  const kept: Array<{ id: number; weight_g: number }> = [];
  for (const row of rows) {
    const key = Math.round(row.weight_g * 10) / 10;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

function stockById(db: DB): Map<number, ItemSummary> {
  const map = new Map<number, ItemSummary>();
  for (const item of itemSummaries(db)) map.set(item.id, item);
  return map;
}

function toAmount(line: IngredientRow): IngredientAmount {
  return {
    quantity: line.quantity,
    unit: line.unit,
    gramsPerPiece: line.grams_per_piece,
    kcalPer100g: line.kcal_per_100g,
  };
}

function gramsOf(line: IngredientRow): number {
  return ingredientGrams(toAmount(line));
}

function lineKcal(line: IngredientRow): number {
  return batchKcal([toAmount(line)]);
}

type RecipeInput = {
  name: string;
  cookedYieldG: number;
  notes: string | null;
  ingredients: Array<{ item_id: number; quantity: number }>;
};

function parseRecipe(db: DB, body: Record<string, unknown>): RecipeInput {
  const name = requiredString(body.name, 'Name');
  if (name.length > 80) throw new HttpError(400, 'Name should be 80 characters or less.');
  const cookedYieldG = requiredNumber(body.cooked_yield_g, 'Cooked yield');
  if (!(cookedYieldG > 0)) throw new HttpError(400, 'Cooked yield must be greater than zero.');
  const notes = optionalText(body.notes, 'Notes');
  if (notes != null && notes.length > 200) throw new HttpError(400, 'Notes should be 200 characters or less.');
  const ingredients = parseIngredients(body.ingredients);
  for (const line of ingredients) {
    const item = get<{ id: number }>(db, 'SELECT id FROM items WHERE id = ?', line.item_id);
    if (!item) throw new HttpError(400, 'That ingredient is not in the grocery list.');
  }
  return { name, cookedYieldG, notes, ingredients };
}

function parseIngredients(value: unknown): Array<{ item_id: number; quantity: number }> {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, 'Add at least one ingredient.');
  const seen = new Set<number>();
  const lines: Array<{ item_id: number; quantity: number }> = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, 'Each ingredient needs an item and an amount.');
    }
    const record = entry as Record<string, unknown>;
    const itemId = requiredNumber(record.item_id, 'Item');
    if (!Number.isInteger(itemId) || itemId <= 0) throw new HttpError(400, 'Item is not a valid id.');
    const quantity = requiredNumber(record.quantity, 'Quantity');
    if (!(quantity > 0)) throw new HttpError(400, 'Quantity must be greater than zero.');
    if (seen.has(itemId)) throw new HttpError(400, 'Each item is only listed once. Add the amounts together.');
    seen.add(itemId);
    lines.push({ item_id: itemId, quantity });
  }
  return lines;
}

function insertIngredients(db: DB, recipeId: number, lines: Array<{ item_id: number; quantity: number }>) {
  const insert = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, item_id, quantity) VALUES (?, ?, ?)
  `);
  for (const line of lines) insert.run(recipeId, line.item_id, line.quantity);
}

function mustRecipe(db: DB, id: number): RecipeRow {
  const recipe = get<RecipeRow>(db, 'SELECT * FROM recipes WHERE id = ?', id);
  if (!recipe) throw new HttpError(404, 'Recipe not found.');
  return recipe;
}

function idParam(value: string | string[] | undefined, label: string): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} is not a valid id.`);
  return id;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${label} is required.`);
  return value.trim();
}

function optionalText(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a number.`);
  return value;
}

function isSqliteConstraint(err: unknown): boolean {
  return typeof err === 'object' && err != null && 'code' in err
    && String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT');
}
