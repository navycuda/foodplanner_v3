// Who gets the stock when two planned dishes want the same thing.
// Earlier days go first, then the order a day is shown: Candy, Dinner,
// Breakfast, Lunch, For Stock. A freezer package is taken whole.

export const MEAL_ORDER = ['candy', 'dinner', 'breakfast', 'lunch', 'for_stock'] as const;
export type MealType = typeof MEAL_ORDER[number];

const EPS = 1e-6;

export type StockPackage = { id: number; weightG: number };

export type ItemStock = {
  unit: 'g' | 'piece';
  gramsPerPiece: number | null;
  loose: number;
  packages: StockPackage[];
};

export type PlanNeed = {
  entryId: number;
  date: string;
  mealType: string;
  itemId: number;
  need: number;
  claimPackageId: number | null;
};

export type ItemTake = {
  entryId: number;
  itemId: number;
  takenLoose: number;
  packageIds: number[];
  /** What this dish holds, in the item's unit. A whole package counts in full. */
  reserved: number;
  shortBy: number;
  enough: boolean;
};

export function mealRank(meal: string): number {
  const index = MEAL_ORDER.indexOf(meal as MealType);
  return index === -1 ? 99 : index;
}

export function allocateDishes(stock: Map<number, ItemStock>, needs: PlanNeed[]): ItemTake[] {
  const looseLeft = new Map<number, number>();
  const packagesLeft = new Map<number, StockPackage[]>();
  for (const [id, item] of stock) {
    looseLeft.set(id, item.loose);
    packagesLeft.set(id, [...item.packages]);
  }
  const claimed = new Set<number>();
  const ordered = [...needs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const rank = mealRank(a.mealType) - mealRank(b.mealType);
    if (rank !== 0) return rank;
    return a.entryId - b.entryId;
  });

  const takes: ItemTake[] = [];
  for (const need of ordered) {
    const item = stock.get(need.itemId);
    if (!item) {
      takes.push(emptyTake(need, need.need));
      continue;
    }
    let remaining = need.need;
    let takenLoose = 0;
    const packageIds: number[] = [];
    const packs = packagesLeft.get(need.itemId) ?? [];

    const takePackage = (pkg: StockPackage) => {
      packageIds.push(pkg.id);
      claimed.add(pkg.id);
      remaining -= packageAmount(item, pkg.weightG);
      const index = packs.findIndex(row => row.id === pkg.id);
      if (index >= 0) packs.splice(index, 1);
    };

    if (need.claimPackageId != null && !claimed.has(need.claimPackageId)) {
      const claimedPkg = item.packages.find(pkg => pkg.id === need.claimPackageId);
      if (claimedPkg) takePackage(claimedPkg);
    }

    if (remaining > EPS) {
      const loose = looseLeft.get(need.itemId) ?? 0;
      const useLoose = Math.min(Math.max(loose, 0), remaining);
      takenLoose += useLoose;
      remaining -= useLoose;
      looseLeft.set(need.itemId, loose - useLoose);
    }

    while (remaining > EPS) {
      const next = packs.find(pkg => !claimed.has(pkg.id));
      if (!next) break;
      takePackage(next);
    }

    let reserved = takenLoose;
    for (const id of packageIds) {
      const pkg = item.packages.find(row => row.id === id);
      if (pkg) reserved += packageAmount(item, pkg.weightG);
    }
    const shortBy = remaining > EPS ? remaining : 0;
    takes.push({
      entryId: need.entryId,
      itemId: need.itemId,
      takenLoose,
      packageIds,
      reserved,
      shortBy,
      enough: shortBy <= EPS,
    });
  }
  return takes;
}

function packageAmount(item: ItemStock, weightG: number): number {
  if (item.unit === 'g') return weightG;
  if (item.gramsPerPiece == null || !(item.gramsPerPiece > 0)) return 0;
  return weightG / item.gramsPerPiece;
}

function emptyTake(need: PlanNeed, shortBy: number): ItemTake {
  return {
    entryId: need.entryId,
    itemId: need.itemId,
    takenLoose: 0,
    packageIds: [],
    reserved: 0,
    shortBy,
    enough: false,
  };
}
