// JSON shapes for the item catalog. Computed fields are not stored.
// Later slices add recipes, plan lines, and shopping onto these same items.

export type Unit = 'g' | 'piece';
export type Source = 'store' | 'homestead';

export type LocationStock = {
  location: string;
  /** `package` for a freezer place. Otherwise the item's unit. */
  unit: Unit | 'package';
  quantity: number;
  grams: number;
};

export type ItemSummary = {
  id: number;
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
  min_stock: number | null;
  max_stock: number | null;
  shelf_life_days: number | null;
  notes: string | null;
  on_hand: number;
  /** Always 0 until planned meals reserve stock. */
  reserved: number;
  available: number;
  below_min: boolean;
  above_max: boolean;
  use_soon: boolean;
  on_hand_by_location: LocationStock[];
  freezer_packages: number;
  latest_store_unit_price_per_g: number | null;
  average_store_unit_price_per_g: number | null;
};

export type PackageInfo = {
  id: number;
  weight_g: number;
  /** Always false until a planned meal holds the package. */
  reserved: boolean;
};

export type LotInfo = {
  id: number;
  added_on: string;
  location: string;
  source: Source;
  total_price: number | null;
  total_g: number;
  quantity: number | null;
  package_count: number | null;
  unit_price_per_g: number | null;
  unit_price_per_package: number | null;
  expiry: string | null;
  use_soon: boolean;
  packages: PackageInfo[];
};

export type ItemDetail = ItemSummary & {
  lots: LotInfo[];
};
