// JSON shapes. Computed fields are not stored.
// Plan lines and the shopping list come in later slices.

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
  /** Held by planned dishes from today on. */
  reserved: number;
  available: number;
  below_min: boolean;
  above_max: boolean;
  use_soon: boolean;
  on_hand_by_location: LocationStock[];
  freezer_packages: number;
  latest_store_unit_price_per_g: number | null;
  average_store_unit_price_per_g: number | null;
  /** Deducted amount divided by the days since the first deduction. Null until something is cooked. */
  use_per_day: number | null;
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

export type RecipeSummary = {
  id: number;
  name: string;
  cooked_yield_g: number;
  notes: string | null;
  /** kcal in the batch as made. */
  kcal: number;
  /** kcal in 100 g of the cooked yield. */
  kcal_per_100g: number;
  use_soon: boolean;
  /** The batch as made fits in available stock. */
  can_make: boolean;
};

export type RecipeIngredient = {
  id: number;
  item_id: number;
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  /** As-made amount, in the item's unit. */
  quantity: number;
  /** As-made raw grams. Pieces already converted. */
  grams: number;
  /** As-made kcal for this line. */
  kcal: number;
  kcal_per_100g: number;
  /** Raw grams / cooked yield. Does not add to 100, because the yield is typed. */
  ww_percent: number;
  use_soon: boolean;
  /** Available stock in the item's unit (on hand minus what a plan has reserved). */
  available: number;
  /** Remaining freezer packages, one row per distinct weight, for the thaw preview. */
  freezer_packages: { id: number; weight_g: number }[];
};

export type RecipePortion = {
  quantity_g: number;
  kcal: number;
  scale: number;
  package_id: number | null;
  package_weight_g: number | null;
  can_make: boolean;
  lines: Array<{
    item_id: number;
    name: string;
    unit: Unit;
    quantity: number;
    grams: number;
    kcal: number;
    available: number;
    enough: boolean;
  }>;
  shortfalls: Array<{
    item_id: number;
    name: string;
    unit: Unit;
    needed: number;
    available: number;
    short_by: number;
  }>;
};

export type RecipeDetail = RecipeSummary & {
  ingredients: RecipeIngredient[];
  /** Full batch when no query was sent. Otherwise the asked amount or the thawed package. */
  portion: RecipePortion;
};

export type MealType = 'candy' | 'dinner' | 'breakfast' | 'lunch' | 'for_stock';

export type PlanDish = {
  id: number;
  date: string;
  recipe_id: number;
  recipe_name: string;
  quantity_g: number;
  meal_type: MealType;
  status: 'planned' | 'deducted';
  editable: boolean;
  kcal: number;
  use_soon: boolean;
  /** False when an earlier planned dish is already holding what this one needs. */
  can_make: boolean;
  /** The package that set the cooked weight, when they chose one. */
  package: { id: number; weight_g: number; item_name: string } | null;
  /** Whole freezer packages this dish is holding, including one it thawed. */
  held_packages: { id: number; weight_g: number; item_name: string }[];
  shortfalls: Array<{
    item_id: number;
    name: string;
    unit: Unit;
    needed: number;
    short_by: number;
  }>;
};
