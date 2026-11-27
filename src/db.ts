import Database from 'better-sqlite3';
import type { Source, Unit } from './types.js';

export type DB = Database.Database;

export type ItemRow = {
  id: number;
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
  min_stock: number | null;
  max_stock: number | null;
  shelf_life_days: number | null;
  notes: string | null;
};

export type LotRow = {
  id: number;
  item_id: number;
  added_on: string;
  location: string;
  source: Source;
  total_price: number | null;
  total_g: number;
  /** Loose stock still on hand, in the item's unit. Null on a freezer lot. */
  quantity: number | null;
  /** Packages as purchased, not how many are left. Null on a loose lot. */
  package_count: number | null;
};

export type PackageRow = {
  id: number;
  lot_id: number;
  weight_g: number;
};

export function openDatabase(filename: string): DB {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL CHECK (unit IN ('g', 'piece')),
      -- Required for pieces (an egg is about 60 g). Null for gram items.
      grams_per_piece REAL,
      kcal_per_100g REAL NOT NULL,
      min_stock REAL,
      max_stock REAL,
      shelf_life_days INTEGER,
      notes TEXT,
      CHECK (
        (unit = 'piece' AND grams_per_piece IS NOT NULL AND grams_per_piece > 0)
        OR (unit = 'g' AND grams_per_piece IS NULL)
      ),
      CHECK (kcal_per_100g >= 0),
      CHECK (min_stock IS NULL OR min_stock >= 0),
      CHECK (max_stock IS NULL OR max_stock >= 0),
      CHECK (min_stock IS NULL OR max_stock IS NULL OR min_stock <= max_stock),
      CHECK (shelf_life_days IS NULL OR shelf_life_days >= 1)
    );

    -- total_price and total_g stay as purchased, so a later stock count
    -- does not change the unit price. quantity is what's left for a loose lot.
    -- Freezer on-hand is the lot_packages rows, not quantity.
    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      added_on TEXT NOT NULL CHECK (added_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      location TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('store', 'homestead')),
      total_price REAL,
      total_g REAL NOT NULL CHECK (total_g > 0),
      quantity REAL,
      package_count INTEGER,
      CHECK (total_price IS NULL OR total_price >= 0),
      CHECK (
        (location = 'freezer' AND package_count IS NOT NULL AND package_count > 0 AND quantity IS NULL)
        OR (location != 'freezer' AND package_count IS NULL AND quantity IS NOT NULL AND quantity >= 0)
      )
    );

    CREATE TABLE IF NOT EXISTS lot_packages (
      id INTEGER PRIMARY KEY,
      lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
      weight_g REAL NOT NULL CHECK (weight_g > 0)
    );

    CREATE INDEX IF NOT EXISTS lots_item ON lots(item_id);
    CREATE INDEX IF NOT EXISTS packages_lot ON lot_packages(lot_id);
  `);
  return db;
}

export function all<T>(db: DB, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: DB, sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
