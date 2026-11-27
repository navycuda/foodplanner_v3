// Pricing, piece-to-gram conversion, and the "use soon" window.
// Recipe portions and freezer packages both scale by a ratio; that division lives here
// so later slices call the same function.

export type PricedLot = {
  source: 'store' | 'homestead';
  total_price: number | null;
  total_g: number;
  added_on: string;
  id: number;
};

/** CAD per gram from the price paid and the grams bought. Null when either is missing. */
export function unitPricePerG(totalPrice: number | null, totalG: number): number | null {
  if (totalPrice == null || !(totalG > 0)) return null;
  return totalPrice / totalG;
}

/** CAD per freezer package. Null for a loose lot or a lot with no price. */
export function unitPricePerPackage(totalPrice: number | null, packageCount: number | null): number | null {
  if (totalPrice == null || packageCount == null || !(packageCount > 0)) return null;
  return totalPrice / packageCount;
}

/**
 * Dollars per gram across store lots, weighted by the grams bought.
 * A 10 kg purchase counts for more than a 100 g one. Homestead lots are skipped.
 */
export function averageStoreUnitPricePerG(lots: PricedLot[]): number | null {
  let spent = 0;
  let grams = 0;
  for (const lot of lots) {
    if (lot.source !== 'store' || lot.total_price == null || !(lot.total_g > 0)) continue;
    spent += lot.total_price;
    grams += lot.total_g;
  }
  if (!(grams > 0)) return null;
  return spent / grams;
}

/** Most recent store purchase that has a price. Same day: the higher id wins. */
export function latestStoreUnitPricePerG(lots: PricedLot[]): number | null {
  let latest: PricedLot | null = null;
  for (const lot of lots) {
    if (lot.source !== 'store' || unitPricePerG(lot.total_price, lot.total_g) == null) continue;
    if (
      latest == null
      || lot.added_on > latest.added_on
      || (lot.added_on === latest.added_on && lot.id > latest.id)
    ) {
      latest = lot;
    }
  }
  if (latest == null) return null;
  return unitPricePerG(latest.total_price, latest.total_g);
}

/** 3 eggs at 60 g each is 180 g. */
export function gramsFromPieces(pieces: number, gramsPerPiece: number): number {
  return pieces * gramsPerPiece;
}

/** kcal per 100 g, applied to a gram weight. */
export function kcalForGrams(grams: number, kcalPer100g: number): number {
  return kcalPer100g * grams / 100;
}

/**
 * `part / whole`. A portion is requested cooked grams / cooked yield.
 * A freezer package is the package grams / the recipe line's grams of that item.
 */
export function scaleFactor(part: number, whole: number): number {
  if (!(whole > 0)) throw new Error('Cannot scale against a zero amount.');
  return part / whole;
}

export function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local calendar day. UTC would flip the date in the evening in Canada. */
export function todayIso(now: Date = new Date()): string {
  return formatIsoDate(now);
}

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

export function addIsoDays(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Bad date ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return formatIsoDate(date);
}

/** Null when the item has no shelf life. Otherwise added_on plus that many days. */
export function expiryDate(addedOn: string, shelfLifeDays: number | null): string | null {
  if (shelfLifeDays == null) return null;
  return addIsoDays(addedOn, shelfLifeDays);
}

/** Expiry today, already past, or within the next 3 days. */
export const USE_SOON_DAYS = 3;

export function isUseSoon(expiry: string | null, today: string): boolean {
  if (expiry == null) return false;
  return expiry <= addIsoDays(today, USE_SOON_DAYS);
}

export type UseFirst = { added_on: string; id: number };

/**
 * Nearest expiry first, then the oldest added_on.
 * Shelf life lives on the item, so every lot of one item shares it and this
 * is the same as oldest-first. The expiry key stays so a later change can
 * differ per lot without rewriting the count.
 */
export function compareUseFirst(a: UseFirst, b: UseFirst, shelfLifeDays: number | null): number {
  const expA = expiryDate(a.added_on, shelfLifeDays);
  const expB = expiryDate(b.added_on, shelfLifeDays);
  if (expA !== expB) {
    if (expA == null) return 1;
    if (expB == null) return -1;
    return expA < expB ? -1 : 1;
  }
  if (a.added_on !== b.added_on) return a.added_on < b.added_on ? -1 : 1;
  return a.id - b.id;
}
