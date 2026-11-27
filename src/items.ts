import type { NextFunction, Request, Response } from 'express';
import type { Express } from 'express';
import { all, get, type DB, type ItemRow, type LotRow, type PackageRow } from './db.js';
import {
  averageStoreUnitPricePerG,
  compareUseFirst,
  expiryDate,
  gramsFromPieces,
  isIsoDate,
  isUseSoon,
  latestStoreUnitPricePerG,
  todayIso,
  unitPricePerG,
  unitPricePerPackage,
  type PricedLot,
} from './math.js';
import type { ItemDetail, ItemSummary, LocationStock, LotInfo, Source, Unit } from './types.js';

// Item catalog and the lots in the house.
//
// A loose lot (pantry, fridge, or a short label) keeps `quantity` in the item's unit.
// A freezer lot keeps one row per package, because a package is thawed whole.
// total_price, total_g, and package_count stay as purchased. A stock count changes
// what's left (quantity, or package rows) and does not rewrite the unit price.
// Homestead lots have no price and are left out of the cost figures.
//
// Slice 4 deducts planned meals whose day has passed before stock is read.
// There is no plan table yet, so there is nothing to deduct.

const EPS = 1e-6;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function registerItemRoutes(app: Express, db: DB) {
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
          res.status(400).json({ error: 'That does not fit the stock rules.' });
          return;
        }
        next(err);
      }
    };
  };

  app.get('/api/items', route((req, res) => {
    const location = queryString(req.query.location);
    const items = all<ItemRow>(db, 'SELECT * FROM items ORDER BY name COLLATE NOCASE, id');
    const listed = items
      .map(item => summarize(db, item))
      .filter(item => location == null || hasStockAt(item, normalizeLocation(location)));
    res.json(listed);
  }));

  app.post('/api/items', route((req, res) => {
    const input = parseItem(bodyObject(req.body));
    const info = db.prepare(`
      INSERT INTO items (name, unit, grams_per_piece, kcal_per_100g, min_stock, max_stock, shelf_life_days, notes)
      VALUES (@name, @unit, @grams_per_piece, @kcal_per_100g, @min_stock, @max_stock, @shelf_life_days, @notes)
    `).run(input);
    const item = mustItem(db, Number(info.lastInsertRowid));
    res.status(201).json(detail(db, item));
  }));

  app.get('/api/items/:id', route((req, res) => {
    res.json(detail(db, mustItem(db, idParam(req.params.id, 'Item'))));
  }));

  app.put('/api/items/:id', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    const input = parseItem(bodyObject(req.body));
    if (input.unit !== item.unit) {
      const lots = lotCount(db, item.id) > 0;
      const usedByRecipe = recipeCount(db, item.id) > 0;
      if (lots && usedByRecipe) {
        throw new HttpError(409, 'Delete the lots and take this item off any recipe before changing the unit.');
      }
      if (lots) throw new HttpError(409, 'Delete the lots before changing the unit.');
      if (usedByRecipe) throw new HttpError(409, 'Take this item off any recipe before changing the unit.');
    }
    const save = db.transaction(() => {
      db.prepare(`
        UPDATE items SET
          name = @name,
          unit = @unit,
          grams_per_piece = @grams_per_piece,
          kcal_per_100g = @kcal_per_100g,
          min_stock = @min_stock,
          max_stock = @max_stock,
          shelf_life_days = @shelf_life_days,
          notes = @notes
        WHERE id = @id
      `).run({ ...input, id: item.id });
      // total_g is the grams originally bought (pieces × grams-per-piece at the time).
      // Scale that figure by the ratio so a half-used dozen keeps its purchase price.
      if (
        input.unit === 'piece'
        && item.unit === 'piece'
        && input.grams_per_piece != null
        && item.grams_per_piece != null
        && input.grams_per_piece !== item.grams_per_piece
      ) {
        db.prepare(`
          UPDATE lots
          SET total_g = total_g * (? / ?)
          WHERE item_id = ? AND location != 'freezer'
        `).run(input.grams_per_piece, item.grams_per_piece, item.id);
      }
    });
    save();
    res.json(detail(db, mustItem(db, item.id)));
  }));

  app.delete('/api/items/:id', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    if (recipeCount(db, item.id) > 0) {
      throw new HttpError(409, 'A recipe uses this item. Take it off the recipe first.');
    }
    if (lotCount(db, item.id) > 0) {
      throw new HttpError(409, 'Delete the lots on this item first.');
    }
    db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
    res.json({ ok: true });
  }));

  app.post('/api/items/:id/lots', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    const lotId = insertLot(db, item, bodyObject(req.body));
    const lot = mustLot(db, item.id, lotId);
    res.status(201).json(presentLot(item, lot, packagesFor(db, [lot.id]), todayIso()));
  }));

  app.put('/api/items/:id/lots/:lotId', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    const lot = mustLot(db, item.id, idParam(req.params.lotId, 'Lot'));
    correctLot(db, item, lot, bodyObject(req.body));
    const updated = mustLot(db, item.id, lot.id);
    res.json(presentLot(item, updated, packagesFor(db, [updated.id]), todayIso()));
  }));

  app.delete('/api/items/:id/lots/:lotId', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    const lot = mustLot(db, item.id, idParam(req.params.lotId, 'Lot'));
    db.prepare('DELETE FROM lots WHERE id = ?').run(lot.id);
    res.json({ ok: true });
  }));

  app.put('/api/items/:id/lots/:lotId/packages/:packageId', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    const lot = mustLot(db, item.id, idParam(req.params.lotId, 'Lot'));
    const packageId = idParam(req.params.packageId, 'Package');
    const weight = requiredNumber(bodyObject(req.body).weight_g, 'Weight');
    if (!(weight > 0)) throw new HttpError(400, 'Package weight must be greater than zero.');
    const row = get<PackageRow>(db, 'SELECT * FROM lot_packages WHERE id = ? AND lot_id = ?', packageId, lot.id);
    if (!row) throw new HttpError(404, 'Package not found.');
    db.prepare('UPDATE lot_packages SET weight_g = ? WHERE id = ?').run(weight, row.id);
    res.json({ id: row.id, weight_g: weight, reserved: false });
  }));

  app.put('/api/items/:id/count', route((req, res) => {
    const item = mustItem(db, idParam(req.params.id, 'Item'));
    applyCount(db, item, bodyObject(req.body));
    res.json(detail(db, mustItem(db, item.id)));
  }));
}

export function itemSummaries(db: DB): ItemSummary[] {
  const items = all<ItemRow>(db, 'SELECT * FROM items ORDER BY name COLLATE NOCASE, id');
  return items.map(item => summarize(db, item));
}

function summarize(db: DB, item: ItemRow): ItemSummary {
  const lots = all<LotRow>(db, 'SELECT * FROM lots WHERE item_id = ?', item.id);
  const packages = packagesFor(db, lots.map(lot => lot.id));
  return presentSummary(item, lots, packages);
}

function detail(db: DB, item: ItemRow): ItemDetail {
  const lots = all<LotRow>(db, 'SELECT * FROM lots WHERE item_id = ?', item.id);
  const packages = packagesFor(db, lots.map(lot => lot.id));
  const today = todayIso();
  const packagesByLot = groupPackages(packages);
  const ordered = [...lots].sort((a, b) => {
    const aStock = lotHasStock(a, packagesByLot) ? 0 : 1;
    const bStock = lotHasStock(b, packagesByLot) ? 0 : 1;
    if (aStock !== bStock) return aStock - bStock;
    return compareUseFirst(a, b, item.shelf_life_days);
  });
  return {
    ...presentSummary(item, lots, packages),
    lots: ordered.map(lot => presentLot(item, lot, packagesByLot.get(lot.id) ?? [], today)),
  };
}

function presentSummary(item: ItemRow, lots: LotRow[], packages: PackageRow[]): ItemSummary {
  const today = todayIso();
  const packagesByLot = groupPackages(packages);
  const places = new Map<string, { quantity: number; packages: number; grams: number }>();
  const ensure = (location: string) => {
    let place = places.get(location);
    if (!place) {
      place = { quantity: 0, packages: 0, grams: 0 };
      places.set(location, place);
    }
    return place;
  };

  let useSoon = false;
  for (const lot of lots) {
    const rows = packagesByLot.get(lot.id) ?? [];
    const stocked = lotHasStock(lot, packagesByLot);
    if (stocked && isUseSoon(expiryDate(lot.added_on, item.shelf_life_days), today)) useSoon = true;
    if (!stocked) continue;
    const place = ensure(lot.location);
    if (lot.location === 'freezer') {
      place.packages += rows.length;
      place.grams += rows.reduce((sum, row) => sum + row.weight_g, 0);
    } else {
      const quantity = lot.quantity ?? 0;
      place.quantity += quantity;
      place.grams += item.unit === 'piece' ? quantity * (item.grams_per_piece ?? 0) : quantity;
    }
  }

  // Loose quantity is already in the item's unit. Freezer packages convert through grams.
  let loose = 0;
  let freezerGrams = 0;
  let freezerPackages = 0;
  for (const place of places.values()) {
    loose += place.quantity;
    freezerPackages += place.packages;
    if (place.packages > 0) freezerGrams += place.grams;
  }
  let onHand = loose;
  if (item.unit === 'g') onHand += freezerGrams;
  else if (item.grams_per_piece) onHand += freezerGrams / item.grams_per_piece;

  const onHandByLocation: LocationStock[] = [...places.entries()].map(([location, place]) => {
    if (place.packages > 0 && place.quantity === 0) {
      return { location, unit: 'package', quantity: place.packages, grams: place.grams };
    }
    return { location, unit: item.unit, quantity: place.quantity, grams: place.grams };
  });
  onHandByLocation.sort((a, b) => locationRank(a.location) - locationRank(b.location) || a.location.localeCompare(b.location));

  const priced: PricedLot[] = lots.map(lot => ({
    source: lot.source,
    total_price: lot.source === 'homestead' ? null : lot.total_price,
    total_g: lot.total_g,
    added_on: lot.added_on,
    id: lot.id,
  }));

  // Reservations arrive with the meal plan. Until then, available is on-hand.
  const reserved = 0;
  const available = onHand - reserved;
  return {
    id: item.id,
    name: item.name,
    unit: item.unit,
    grams_per_piece: item.grams_per_piece,
    kcal_per_100g: item.kcal_per_100g,
    min_stock: item.min_stock,
    max_stock: item.max_stock,
    shelf_life_days: item.shelf_life_days,
    notes: item.notes,
    on_hand: onHand,
    reserved,
    available,
    below_min: item.min_stock != null && available < item.min_stock,
    above_max: item.max_stock != null && available > item.max_stock,
    use_soon: useSoon,
    on_hand_by_location: onHandByLocation,
    freezer_packages: freezerPackages,
    latest_store_unit_price_per_g: latestStoreUnitPricePerG(priced),
    average_store_unit_price_per_g: averageStoreUnitPricePerG(priced),
  };
}

function presentLot(item: ItemRow, lot: LotRow, packages: PackageRow[], today: string): LotInfo {
  const expiry = expiryDate(lot.added_on, item.shelf_life_days);
  const stocked = lot.location === 'freezer' ? packages.length > 0 : (lot.quantity ?? 0) > 0;
  const price = lot.source === 'homestead' ? null : lot.total_price;
  return {
    id: lot.id,
    added_on: lot.added_on,
    location: lot.location,
    source: lot.source,
    total_price: price,
    total_g: lot.total_g,
    quantity: lot.quantity,
    package_count: lot.package_count,
    unit_price_per_g: unitPricePerG(price, lot.total_g),
    unit_price_per_package: unitPricePerPackage(price, lot.package_count),
    expiry,
    use_soon: stocked && isUseSoon(expiry, today),
    packages: packages.map(row => ({ id: row.id, weight_g: row.weight_g, reserved: false })),
  };
}

function insertLot(db: DB, item: ItemRow, body: Record<string, unknown>): number {
  const location = normalizeLocation(requiredString(body.location, 'Location'));
  const source = parseSource(body.source);
  const addedOn = body.added_on == null || body.added_on === '' ? todayIso() : parseDate(body.added_on);
  const totalPrice = priceFor(source, body.total_price);

  if (location === 'freezer') {
    const totalG = requiredNumber(body.total_g, 'Total grams');
    const packageCount = requiredNumber(body.package_count, 'Package count');
    if (!(totalG > 0)) throw new HttpError(400, 'Total grams must be greater than zero.');
    if (!Number.isInteger(packageCount) || packageCount <= 0) {
      throw new HttpError(400, 'Package count must be a whole number greater than zero.');
    }
    const average = totalG / packageCount;
    const create = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO lots (item_id, added_on, location, source, total_price, total_g, quantity, package_count)
        VALUES (@item_id, @added_on, @location, @source, @total_price, @total_g, NULL, @package_count)
      `).run({
        item_id: item.id,
        added_on: addedOn,
        location,
        source,
        total_price: totalPrice,
        total_g: totalG,
        package_count: packageCount,
      });
      const lotId = Number(info.lastInsertRowid);
      const insertPackage = db.prepare('INSERT INTO lot_packages (lot_id, weight_g) VALUES (?, ?)');
      for (let i = 0; i < packageCount; i++) insertPackage.run(lotId, average);
      return lotId;
    });
    return create();
  }

  const loose = loosePurchase(item, body);
  const info = db.prepare(`
    INSERT INTO lots (item_id, added_on, location, source, total_price, total_g, quantity, package_count)
    VALUES (@item_id, @added_on, @location, @source, @total_price, @total_g, @quantity, NULL)
  `).run({
    item_id: item.id,
    added_on: addedOn,
    location,
    source,
    total_price: totalPrice,
    total_g: loose.totalG,
    quantity: loose.quantity,
  });
  return Number(info.lastInsertRowid);
}

/** Correct the purchase record. Use a stock count to record what was used. */
function correctLot(db: DB, item: ItemRow, lot: LotRow, body: Record<string, unknown>) {
  const location = body.location == null ? lot.location : normalizeLocation(requiredString(body.location, 'Location'));
  if ((location === 'freezer') !== (lot.location === 'freezer')) {
    throw new HttpError(400, 'A freezer lot stays a freezer lot. Delete it and add it again if it moved.');
  }
  const source = body.source == null ? lot.source : parseSource(body.source);
  const addedOn = body.added_on == null ? lot.added_on : parseDate(body.added_on);
  const totalPrice = body.total_price === undefined ? (source === 'homestead' ? null : lot.total_price) : priceFor(source, body.total_price);
  if (body.package_count != null && Number(body.package_count) !== lot.package_count) {
    throw new HttpError(400, 'Package count stays as it was recorded. Delete the lot and add it again to change it.');
  }

  if (lot.location === 'freezer') {
    const totalG = body.total_g == null ? lot.total_g : requiredNumber(body.total_g, 'Total grams');
    if (!(totalG > 0)) throw new HttpError(400, 'Total grams must be greater than zero.');
    const save = db.transaction(() => {
      rescaleAveragePackages(db, lot, totalG);
      db.prepare(`
        UPDATE lots SET added_on = ?, location = ?, source = ?, total_price = ?, total_g = ? WHERE id = ?
      `).run(addedOn, location, source, totalPrice, totalG, lot.id);
    });
    save();
    return;
  }

  const loose = body.quantity == null && body.total_g == null
    ? { quantity: lot.quantity ?? 0, totalG: lot.total_g }
    : loosePurchase(item, {
        quantity: body.quantity ?? body.total_g,
        total_g: body.total_g ?? body.quantity,
      });
  db.prepare(`
    UPDATE lots SET added_on = ?, location = ?, source = ?, total_price = ?, total_g = ?, quantity = ? WHERE id = ?
  `).run(addedOn, location, source, totalPrice, loose.totalG, loose.quantity, lot.id);
}

function applyCount(db: DB, item: ItemRow, body: Record<string, unknown>) {
  const target = requiredNumber(body.quantity, 'Quantity');
  if (target < 0) throw new HttpError(400, 'Quantity cannot be negative.');
  const location = body.location == null || body.location === ''
    ? null
    : normalizeLocation(requiredString(body.location, 'Location'));
  const source = body.source == null || body.source === '' ? 'store' : parseSource(body.source);

  const lots = all<LotRow>(db, 'SELECT * FROM lots WHERE item_id = ?', item.id);
  const freezerLots = lots.filter(lot => lot.location === 'freezer');
  const looseLots = lots.filter(lot => lot.location !== 'freezer');
  const countFreezer = location === 'freezer' || (location == null && freezerLots.length > 0 && looseLots.length === 0);
  if (location == null && freezerLots.length > 0 && looseLots.length > 0) {
    throw new HttpError(400, 'This item has freezer packages and loose stock. Include a location so the count knows which one you measured.');
  }

  const save = db.transaction(() => {
    if (countFreezer) setFreezerCount(db, item, target);
    else setLooseCount(db, item, location, target, source);
  });
  save();
}

function setLooseCount(db: DB, item: ItemRow, location: string | null, target: number, source: Source) {
  const lots = all<LotRow>(db, `SELECT * FROM lots WHERE item_id = ? AND location != 'freezer'`, item.id)
    .filter(lot => location == null || lot.location === location);
  const onHand = lots.reduce((sum, lot) => sum + (lot.quantity ?? 0), 0);
  if (Math.abs(onHand - target) <= EPS) return;

  if (target > onHand) {
    const extra = target - onHand;
    const where = location ?? 'pantry';
    const totalG = item.unit === 'piece' ? pieceGrams(item, extra) : extra;
    db.prepare(`
      INSERT INTO lots (item_id, added_on, location, source, total_price, total_g, quantity, package_count)
      VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)
    `).run(item.id, todayIso(), where, source, totalG, extra);
    return;
  }

  // Slice 3 will skip amounts a planned meal is still holding, unless the count cannot be met otherwise.
  let remove = onHand - target;
  const ordered = [...lots].sort((a, b) => compareUseFirst(a, b, item.shelf_life_days));
  const update = db.prepare('UPDATE lots SET quantity = ? WHERE id = ?');
  for (const lot of ordered) {
    if (remove <= EPS) break;
    const have = lot.quantity ?? 0;
    const take = Math.min(have, remove);
    let next = have - take;
    if (next < EPS) next = 0;
    update.run(next, lot.id);
    remove -= take;
  }
}

function setFreezerCount(db: DB, item: ItemRow, target: number) {
  if (!Number.isInteger(target)) throw new HttpError(400, 'A freezer count is a whole number of packages.');
  const lots = all<LotRow>(db, `SELECT * FROM lots WHERE item_id = ? AND location = 'freezer'`, item.id);
  const packages = packagesFor(db, lots.map(lot => lot.id));
  if (packages.length === target) return;

  if (target > packages.length) {
    const extra = target - packages.length;
    const ordered = [...lots].sort((a, b) => compareUseFirst(a, b, item.shelf_life_days));
    const lot = ordered[ordered.length - 1];
    if (lot == null || lot.package_count == null || !(lot.package_count > 0)) {
      throw new HttpError(400, 'Add a freezer lot first, so extra packages have an average weight.');
    }
    const average = lot.total_g / lot.package_count;
    const insert = db.prepare('INSERT INTO lot_packages (lot_id, weight_g) VALUES (?, ?)');
    for (let i = 0; i < extra; i++) insert.run(lot.id, average);
    return;
  }

  // Which physical package left is not recorded. Oldest lot first, newest row inside that lot.
  let drop = packages.length - target;
  const ordered = [...lots].sort((a, b) => compareUseFirst(a, b, item.shelf_life_days));
  const remove = db.prepare('DELETE FROM lot_packages WHERE id = ?');
  for (const lot of ordered) {
    const rows = packages.filter(row => row.lot_id === lot.id).sort((a, b) => b.id - a.id);
    for (const row of rows) {
      if (drop <= 0) return;
      remove.run(row.id);
      drop -= 1;
    }
  }
}

/** Packages still on the old average follow a corrected total. A typed weight stays. */
function rescaleAveragePackages(db: DB, lot: LotRow, newTotalG: number) {
  if (lot.package_count == null || !(lot.package_count > 0) || !(lot.total_g > 0)) return;
  const oldAverage = lot.total_g / lot.package_count;
  const newAverage = newTotalG / lot.package_count;
  const rows = all<PackageRow>(db, 'SELECT * FROM lot_packages WHERE lot_id = ?', lot.id);
  const update = db.prepare('UPDATE lot_packages SET weight_g = ? WHERE id = ?');
  for (const row of rows) {
    if (Math.abs(row.weight_g - oldAverage) < 0.05) update.run(newAverage, row.id);
  }
}

function loosePurchase(item: ItemRow, body: Record<string, unknown>): { quantity: number; totalG: number } {
  if (item.unit === 'piece') {
    const quantity = requiredNumber(body.quantity, 'Quantity');
    if (!(quantity > 0)) throw new HttpError(400, 'Quantity must be greater than zero.');
    return { quantity, totalG: pieceGrams(item, quantity) };
  }
  const totalG = optionalNumber(body.total_g, 'Total grams');
  const quantity = optionalNumber(body.quantity, 'Quantity');
  const grams = totalG ?? quantity;
  if (grams == null) throw new HttpError(400, 'Total grams is required.');
  if (!(grams > 0)) throw new HttpError(400, 'Total grams must be greater than zero.');
  if (totalG != null && quantity != null && Math.abs(totalG - quantity) > 0.01) {
    throw new HttpError(400, 'For a gram item, quantity and total grams are the same number.');
  }
  return { quantity: grams, totalG: grams };
}

function pieceGrams(item: ItemRow, pieces: number): number {
  if (item.grams_per_piece == null || !(item.grams_per_piece > 0)) {
    throw new HttpError(400, 'This piece item needs grams per piece before stock can be added.');
  }
  return gramsFromPieces(pieces, item.grams_per_piece);
}

type ItemInput = {
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
  min_stock: number | null;
  max_stock: number | null;
  shelf_life_days: number | null;
  notes: string | null;
};

function parseItem(body: Record<string, unknown>): ItemInput {
  const name = requiredString(body.name, 'Name');
  if (name.length > 80) throw new HttpError(400, 'Name should be 80 characters or less.');
  if (body.unit !== 'g' && body.unit !== 'piece') throw new HttpError(400, 'Unit must be g or piece.');
  const unit: Unit = body.unit;
  let grams = optionalNumber(body.grams_per_piece, 'Grams per piece');
  if (unit === 'g') grams = null;
  if (unit === 'piece' && !(grams != null && grams > 0)) {
    throw new HttpError(400, 'A piece item needs grams per piece, for example 60 for an egg.');
  }
  const kcal = requiredNumber(body.kcal_per_100g, 'kcal per 100 g');
  if (kcal < 0) throw new HttpError(400, 'kcal per 100 g cannot be negative.');
  const minStock = optionalNumber(body.min_stock, 'Min stock');
  const maxStock = optionalNumber(body.max_stock, 'Max stock');
  if (minStock != null && minStock < 0) throw new HttpError(400, 'Min stock cannot be negative.');
  if (maxStock != null && maxStock < 0) throw new HttpError(400, 'Max stock cannot be negative.');
  if (minStock != null && maxStock != null && minStock > maxStock) {
    throw new HttpError(400, 'Min stock cannot be above max stock.');
  }
  const shelf = optionalNumber(body.shelf_life_days, 'Shelf life');
  if (shelf != null && (!Number.isInteger(shelf) || shelf < 1)) {
    throw new HttpError(400, 'Shelf life must be a whole number of days.');
  }
  const notes = optionalText(body.notes, 'Notes');
  if (notes != null && notes.length > 200) throw new HttpError(400, 'Notes should be 200 characters or less.');
  return {
    name,
    unit,
    grams_per_piece: grams,
    kcal_per_100g: kcal,
    min_stock: minStock,
    max_stock: maxStock,
    shelf_life_days: shelf,
    notes,
  };
}

function priceFor(source: Source, value: unknown): number | null {
  if (source === 'homestead') return null;
  const price = optionalNumber(value, 'Total price');
  if (price != null && price < 0) throw new HttpError(400, 'Total price cannot be negative.');
  return price;
}

function parseSource(value: unknown): Source {
  if (value === 'store' || value === 'homestead') return value;
  throw new HttpError(400, 'Source must be store or homestead.');
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !isIsoDate(value)) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
  return value;
}

function normalizeLocation(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'pantry' || lower === 'fridge' || lower === 'freezer') return lower;
  if (!trimmed) throw new HttpError(400, 'Location is required.');
  if (trimmed.length > 40) throw new HttpError(400, 'Location should be a short label.');
  return trimmed;
}

function lotHasStock(lot: LotRow, packagesByLot: Map<number, PackageRow[]>): boolean {
  if (lot.location === 'freezer') return (packagesByLot.get(lot.id) ?? []).length > 0;
  return (lot.quantity ?? 0) > 0;
}

function hasStockAt(item: ItemSummary, location: string): boolean {
  return item.on_hand_by_location.some(place => place.location === location && place.quantity > 0);
}

function locationRank(location: string): number {
  if (location === 'pantry') return 0;
  if (location === 'fridge') return 1;
  if (location === 'freezer') return 2;
  return 9;
}

function groupPackages(packages: PackageRow[]): Map<number, PackageRow[]> {
  const grouped = new Map<number, PackageRow[]>();
  for (const row of packages) {
    const list = grouped.get(row.lot_id) ?? [];
    list.push(row);
    grouped.set(row.lot_id, list);
  }
  return grouped;
}

function packagesFor(db: DB, lotIds: number[]): PackageRow[] {
  if (lotIds.length === 0) return [];
  const marks = lotIds.map(() => '?').join(',');
  return all<PackageRow>(db, `SELECT * FROM lot_packages WHERE lot_id IN (${marks}) ORDER BY id`, ...lotIds);
}

function lotCount(db: DB, itemId: number): number {
  const row = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM lots WHERE item_id = ?', itemId);
  return row?.n ?? 0;
}

function recipeCount(db: DB, itemId: number): number {
  const row = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM recipe_ingredients WHERE item_id = ?', itemId);
  return row?.n ?? 0;
}

function mustItem(db: DB, id: number): ItemRow {
  const item = get<ItemRow>(db, 'SELECT * FROM items WHERE id = ?', id);
  if (!item) throw new HttpError(404, 'Item not found.');
  return item;
}

function mustLot(db: DB, itemId: number, lotId: number): LotRow {
  const lot = get<LotRow>(db, 'SELECT * FROM lots WHERE id = ? AND item_id = ?', lotId, itemId);
  if (!lot) throw new HttpError(404, 'Lot not found.');
  return lot;
}

function idParam(value: string | string[] | undefined, label: string): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} is not a valid id.`);
  return id;
}

function queryString(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) throw new HttpError(400, 'Query parameters must be single values.');
  if (typeof value !== 'string') throw new HttpError(400, 'Query parameters must be single values.');
  return value;
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
  const n = optionalNumber(value, label);
  if (n == null) throw new HttpError(400, `${label} is required.`);
  return n;
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a number.`);
  return value;
}

function isSqliteConstraint(err: unknown): boolean {
  return typeof err === 'object' && err != null && 'code' in err
    && String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT');
}
