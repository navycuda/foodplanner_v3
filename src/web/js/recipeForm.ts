import type { Unit } from '../../types.js';

export type ItemChoice = {
  id: number;
  name: string;
  unit: Unit;
  grams_per_piece: number | null;
  kcal_per_100g: number;
  available: number;
  use_soon: boolean;
};

export type DraftLine = {
  item_id: number;
  quantity: number | null;
};

export function fillIngredientHost(host: HTMLElement, items: ItemChoice[], lines: DraftLine[]) {
  host.replaceChildren();
  const seed = lines.length > 0 ? lines : [{ item_id: items[0]?.id ?? 0, quantity: null }];
  for (const line of seed) host.append(ingredientRow(host, items, line));
}

export function readIngredientHost(host: HTMLElement): Array<{ item_id: number; quantity: number }> {
  const rows = [...host.querySelectorAll('.ingredient')];
  if (rows.length === 0) throw new Error('Add at least one ingredient.');
  const seen = new Set<number>();
  const lines: Array<{ item_id: number; quantity: number }> = [];
  for (const row of rows) {
    const select = row.querySelector('select');
    const input = row.querySelector('input');
    if (!(select instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) {
      throw new Error('Add at least one ingredient.');
    }
    const itemId = Number(select.value);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('Pick an ingredient from the grocery list.');
    if (input.value.trim() === '') throw new Error('Each ingredient needs an amount.');
    const quantity = Number(input.value);
    if (!Number.isFinite(quantity) || !(quantity > 0)) throw new Error('Amount must be greater than zero.');
    if (seen.has(itemId)) throw new Error('Each item is only listed once. Add the amounts together.');
    seen.add(itemId);
    lines.push({ item_id: itemId, quantity });
  }
  return lines;
}

function ingredientRow(host: HTMLElement, items: ItemChoice[], line: DraftLine) {
  const wrap = document.createElement('div');
  wrap.className = 'ingredient';
  const select = document.createElement('select');
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = `${item.name} (${item.unit === 'piece' ? 'pieces' : 'g'})`;
    if (item.id === line.item_id) option.selected = true;
    select.append(option);
  }
  const quantity = document.createElement('input');
  quantity.type = 'number';
  quantity.min = '0';
  quantity.step = 'any';
  quantity.inputMode = 'decimal';
  quantity.placeholder = 'Amount';
  quantity.value = line.quantity == null ? '' : String(line.quantity);
  const amountLabel = document.createElement('span');
  const hint = document.createElement('span');
  hint.className = 'note';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    wrap.remove();
    host.dispatchEvent(new Event('ingredients-changed', { bubbles: true }));
  });

  const refresh = (notify: boolean) => {
    const item = items.find(choice => choice.id === Number(select.value));
    amountLabel.textContent = item?.unit === 'piece' ? 'Pieces' : 'Grams';
    hint.textContent = hintFor(item, quantity.value);
    if (notify) host.dispatchEvent(new Event('ingredients-changed', { bubbles: true }));
  };
  select.addEventListener('change', () => refresh(true));
  quantity.addEventListener('input', () => refresh(true));
  refresh(false);

  wrap.append(labeled('Item', select), labeledAmount(amountLabel, quantity), hint, remove);
  return wrap;
}

function hintFor(item: ItemChoice | undefined, raw: string): string {
  if (!item) return '';
  if (raw.trim() === '') return item.unit === 'piece' ? 'Raw pieces. Grams are for the calorie math.' : 'Raw grams, before cooking.';
  const quantity = Number(raw);
  if (!Number.isFinite(quantity) || !(quantity > 0)) return '';
  if (item.unit === 'piece' && item.grams_per_piece) {
    const grams = quantity * item.grams_per_piece;
    return `${trimNumber(quantity)} ${quantity === 1 ? 'piece' : 'pieces'} is ${trimNumber(grams)} g raw.`;
  }
  return 'Raw grams, before cooking.';
}

function trimNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function labeled(text: string, control: HTMLElement) {
  const label = document.createElement('label');
  label.append(text, control);
  return label;
}

function labeledAmount(title: HTMLElement, control: HTMLElement) {
  const label = document.createElement('label');
  label.append(title, control);
  return label;
}
