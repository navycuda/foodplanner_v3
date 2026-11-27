// What a past dish takes off the shelf, what to buy, and what a line costs.
// Lots must already be in use-soon / oldest-first order. A package is taken whole.

const EPS = 1e-6;

export type StockPiece = {
  id: number;
  kind: 'loose' | 'package';
  /** Loose amount still on the lot, or the whole package, in the item's unit. */
  amount: number;
};

export type Consumption = {
  consumed: number;
  looseTakes: { id: number; take: number }[];
  packageIds: number[];
};

export function consumeStock(need: number, pieces: StockPiece[]): Consumption {
  let remaining = need;
  let consumed = 0;
  const looseTakes: { id: number; take: number }[] = [];
  const packageIds: number[] = [];
  for (const piece of pieces) {
    if (remaining <= EPS) break;
    if (piece.kind === 'package') {
      packageIds.push(piece.id);
      consumed += piece.amount;
      remaining -= piece.amount;
      continue;
    }
    const take = Math.min(Math.max(piece.amount, 0), remaining);
    if (take <= EPS) continue;
    looseTakes.push({ id: piece.id, take });
    consumed += take;
    remaining -= take;
  }
  return { consumed, looseTakes, packageIds };
}

/**
 * Buy the plan's shortfall, and if available stock is under min, enough to reach max
 * (or min, when max is not set). One number, so the two reasons are not added twice.
 */
export function shopQuantity(
  planShort: number,
  available: number,
  min: number | null,
  max: number | null,
): number {
  let topUp = 0;
  if (min != null && available < min - EPS) {
    const target = max != null ? max : min;
    topUp = Math.max(0, target - available);
  }
  return Math.max(Math.max(planShort, 0), topUp);
}

/** CAD for a shopping line. Null when there is no store price (homestead, or never priced). */
export function lineCost(
  quantity: number,
  unit: 'g' | 'piece',
  gramsPerPiece: number | null,
  pricePerG: number | null,
): number | null {
  if (pricePerG == null) return null;
  const grams = unit === 'piece' ? quantity * (gramsPerPiece ?? 0) : quantity;
  return grams * pricePerG;
}

/** Days from the first deduction through today. At least one, so a single cook still has a rate. */
export function usePerDay(total: number, firstDay: string, today: string): number {
  const [fy, fm, fd] = firstDay.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const first = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1);
  const end = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1);
  const days = Math.max(1, Math.round((end - first) / 86400000));
  return total / days;
}
