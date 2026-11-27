import type { Unit } from '../../types.js';

// Same ratio the server uses: requested cooked grams / cooked yield.
// Pieces become grams only for kcal and the raw-over-cooked percent.

export type PreviewLine = {
  name: string;
  unit: Unit;
  quantity: number;
  gramsPerPiece: number | null;
  kcalPer100g: number;
  available: number;
  useSoon: boolean;
};

export type ScaledLine = {
  name: string;
  unit: Unit;
  quantity: number;
  grams: number;
  scaledQuantity: number;
  scaledGrams: number;
  kcal: number;
  wwPercent: number;
  available: number;
  enough: boolean;
  shortBy: number;
  useSoon: boolean;
};

export type RecipePreview = {
  scale: number;
  batchKcal: number;
  portionKcal: number;
  kcalPer100g: number;
  useSoon: boolean;
  canMake: boolean;
  lines: ScaledLine[];
};

export function previewRecipe(cookedYieldG: number, requestedG: number, lines: PreviewLine[]): RecipePreview {
  if (!(cookedYieldG > 0)) throw new Error('Cooked yield must be greater than zero.');
  if (!(requestedG > 0)) throw new Error('Ask for a cooked weight greater than zero.');
  const scale = requestedG / cookedYieldG;
  const scaled: ScaledLine[] = lines.map(line => {
    const grams = lineGrams(line.quantity, line.unit, line.gramsPerPiece);
    const scaledQuantity = line.quantity * scale;
    const shortBy = scaledQuantity - line.available;
    return {
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      grams,
      scaledQuantity,
      scaledGrams: grams * scale,
      kcal: grams * line.kcalPer100g / 100,
      wwPercent: grams / cookedYieldG * 100,
      available: line.available,
      enough: shortBy <= 1e-6,
      shortBy: shortBy > 1e-6 ? shortBy : 0,
      useSoon: line.useSoon,
    };
  });
  const batchKcal = scaled.reduce((sum, line) => sum + line.kcal, 0);
  return {
    scale,
    batchKcal,
    portionKcal: batchKcal * scale,
    kcalPer100g: batchKcal * 100 / cookedYieldG,
    useSoon: scaled.some(line => line.useSoon),
    canMake: scaled.every(line => line.enough),
    lines: scaled,
  };
}

/** Cooked grams if this package replaces the ingredient line. */
export function cookedGramsForPackage(cookedYieldG: number, lineGramsAmount: number, packageG: number): number {
  if (!(lineGramsAmount > 0)) throw new Error('That ingredient has no weight to scale from.');
  return cookedYieldG * (packageG / lineGramsAmount);
}

export function lineGrams(quantity: number, unit: Unit, gramsPerPiece: number | null): number {
  if (unit === 'g') return quantity;
  return quantity * (gramsPerPiece ?? 0);
}

export function formatKcal(amount: number): string {
  const rounded = Math.round(Math.abs(amount) * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${amount < 0 ? '-' : ''}${text} kcal`;
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}
