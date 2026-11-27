import type { Unit } from '../../types.js';

export type ItemFields = {
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
  min_stock: number | null;
  max_stock: number | null;
  shelf_life_days: number | null;
  notes: string | null;
};

export function readItemForm(form: HTMLFormElement): ItemFields {
  const data = new FormData(form);
  const name = text(data, 'name');
  if (!name) throw new Error('Name is required.');
  const unit: Unit = data.get('unit') === 'piece' ? 'piece' : 'g';
  const grams = numberOrNull(data, 'grams_per_piece');
  if (unit === 'piece' && !(grams != null && grams > 0)) {
    throw new Error('A piece item needs grams per piece, for example 60 for an egg.');
  }
  const kcal = numberOrNull(data, 'kcal_per_100g');
  if (kcal == null || kcal < 0) throw new Error('kcal per 100 g is required.');
  const minStock = numberOrNull(data, 'min_stock');
  const maxStock = numberOrNull(data, 'max_stock');
  if (minStock != null && minStock < 0) throw new Error('Min stock cannot be negative.');
  if (maxStock != null && maxStock < 0) throw new Error('Max stock cannot be negative.');
  if (minStock != null && maxStock != null && minStock > maxStock) {
    throw new Error('Min stock cannot be above max stock.');
  }
  const shelf = numberOrNull(data, 'shelf_life_days');
  if (shelf != null && (!Number.isInteger(shelf) || shelf < 1)) {
    throw new Error('Shelf life must be a whole number of days.');
  }
  const notes = text(data, 'notes');
  return {
    name,
    unit,
    grams_per_piece: unit === 'piece' ? grams : null,
    kcal_per_100g: kcal,
    min_stock: minStock,
    max_stock: maxStock,
    shelf_life_days: shelf,
    notes,
  };
}

export function fillItemForm(form: HTMLFormElement, item: ItemFields) {
  setValue(form, 'name', item.name);
  setValue(form, 'unit', item.unit);
  setValue(form, 'grams_per_piece', item.grams_per_piece == null ? '' : String(item.grams_per_piece));
  setValue(form, 'kcal_per_100g', String(item.kcal_per_100g));
  setValue(form, 'min_stock', item.min_stock == null ? '' : String(item.min_stock));
  setValue(form, 'max_stock', item.max_stock == null ? '' : String(item.max_stock));
  setValue(form, 'shelf_life_days', item.shelf_life_days == null ? '' : String(item.shelf_life_days));
  setValue(form, 'notes', item.notes ?? '');
  syncPieceField(form);
}

export function syncPieceField(form: HTMLFormElement) {
  const unit = form.elements.namedItem('unit');
  const field = form.querySelector('[data-piece-field]');
  if (field instanceof HTMLElement && unit instanceof HTMLSelectElement) {
    field.hidden = unit.value !== 'piece';
  }
}

function setValue(form: HTMLFormElement, name: string, value: string) {
  const element = form.elements.namedItem(name);
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    element.value = value;
  }
}

function text(data: FormData, name: string): string | null {
  const raw = data.get(name);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(data: FormData, name: string): number | null {
  const raw = data.get(name);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('Enter a number.');
  return n;
}
