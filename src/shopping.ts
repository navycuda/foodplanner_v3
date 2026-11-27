import type { Express, NextFunction, Request, Response } from 'express';
import { lineCost, shopQuantity } from './consume.js';
import { all, get, type DB } from './db.js';
import { deductElapsed } from './deduct.js';
import { itemSummaries } from './items.js';
import { planShortByItem } from './plan.js';
import type { Unit } from './types.js';

// The list looks forward from today. Unticked generated lines are replaced
// when the list is rebuilt. Ticked lines and anything added by hand stay.

const EPS = 1e-6;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type ShoppingRow = {
  id: number;
  item_id: number | null;
  name: string;
  quantity: number;
  unit: Unit;
  checked: number;
  source: 'manual' | 'generated';
};

export type ShoppingList = {
  lines: Array<ShoppingRow & { estimated_cost: number | null }>;
  total: number;
};

export function registerShoppingRoutes(app: Express, db: DB) {
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

  app.get('/api/shopping', route((_req, res) => {
    res.json(present(db));
  }));

  app.post('/api/shopping/generate', route((_req, res) => {
    rebuildGenerated(db);
    res.json(present(db));
  }));

  app.post('/api/shopping', route((req, res) => {
    const body = bodyObject(req.body);
    const name = requiredString(body.name, 'Name');
    if (name.length > 80) throw new HttpError(400, 'Name should be 80 characters or less.');
    const quantity = requiredNumber(body.quantity, 'Quantity');
    if (!(quantity > 0)) throw new HttpError(400, 'Quantity must be greater than zero.');
    const unit = body.unit === 'piece' ? 'piece' : body.unit === 'g' ? 'g' : null;
    if (!unit) throw new HttpError(400, 'Unit must be g or piece.');
    const info = db.prepare(`
      INSERT INTO shopping_items (item_id, name, quantity, unit, checked, source)
      VALUES (NULL, ?, ?, ?, 0, 'manual')
    `).run(name, quantity, unit);
    res.status(201).json(presentOne(db, Number(info.lastInsertRowid)));
  }));

  app.put('/api/shopping/:id', route((req, res) => {
    const row = mustRow(db, idParam(req.params.id, 'Line'));
    const body = bodyObject(req.body);
    let quantity = row.quantity;
    let checked = row.checked;
    let name = row.name;
    if (body.quantity != null) {
      quantity = requiredNumber(body.quantity, 'Quantity');
      if (!(quantity > 0)) throw new HttpError(400, 'Quantity must be greater than zero.');
    }
    if (body.checked != null) {
      if (body.checked !== 0 && body.checked !== 1) throw new HttpError(400, 'Checked must be 0 or 1.');
      checked = body.checked;
    }
    if (body.name != null) {
      name = requiredString(body.name, 'Name');
    }
    db.prepare('UPDATE shopping_items SET quantity = ?, checked = ?, name = ? WHERE id = ?')
      .run(quantity, checked, name, row.id);
    res.json(presentOne(db, row.id));
  }));

  app.delete('/api/shopping/:id', route((req, res) => {
    const row = mustRow(db, idParam(req.params.id, 'Line'));
    db.prepare('DELETE FROM shopping_items WHERE id = ?').run(row.id);
    res.json({ ok: true });
  }));
}

function rebuildGenerated(db: DB) {
  const shorts = planShortByItem(db);
  const items = itemSummaries(db);
  const kept = all<{ item_id: number }>(db, `
    SELECT item_id FROM shopping_items
    WHERE source = 'generated' AND checked = 1 AND item_id IS NOT NULL
  `);
  const skip = new Set(kept.map(row => row.item_id));
  db.prepare(`DELETE FROM shopping_items WHERE source = 'generated' AND checked = 0`).run();
  const insert = db.prepare(`
    INSERT INTO shopping_items (item_id, name, quantity, unit, checked, source)
    VALUES (?, ?, ?, ?, 0, 'generated')
  `);
  for (const item of items) {
    if (skip.has(item.id)) continue;
    const quantity = shopQuantity(shorts.get(item.id) ?? 0, item.available, item.min_stock, item.max_stock);
    if (!(quantity > EPS)) continue;
    insert.run(item.id, item.name, quantity, item.unit);
  }
}

function present(db: DB): ShoppingList {
  const rows = all<ShoppingRow>(db, 'SELECT * FROM shopping_items ORDER BY checked, name COLLATE NOCASE, id');
  const lines = rows.map(row => withCost(db, row));
  const total = lines.reduce((sum, line) => sum + (line.estimated_cost ?? 0), 0);
  return { lines, total };
}

function presentOne(db: DB, id: number) {
  return withCost(db, mustRow(db, id));
}

function withCost(db: DB, row: ShoppingRow): ShoppingRow & { estimated_cost: number | null } {
  if (row.item_id == null) return { ...row, estimated_cost: null };
  const item = get<{ grams_per_piece: number | null; latest: number | null }>(db, `
    SELECT grams_per_piece,
           (
             SELECT total_price / total_g FROM lots
             WHERE item_id = items.id AND source = 'store' AND total_price IS NOT NULL AND total_g > 0
             ORDER BY added_on DESC, id DESC
             LIMIT 1
           ) AS latest
    FROM items WHERE id = ?
  `, row.item_id);
  const cost = lineCost(row.quantity, row.unit, item?.grams_per_piece ?? null, item?.latest ?? null);
  return { ...row, estimated_cost: cost };
}

function mustRow(db: DB, id: number): ShoppingRow {
  const row = get<ShoppingRow>(db, 'SELECT * FROM shopping_items WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Line not found.');
  return row;
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${label} is required.`);
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a number.`);
  return value;
}
