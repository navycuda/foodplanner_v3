import type { ItemSummary } from '../../types.js';
import { api, getElementByIdOrThrow } from './common.js';
import InventoryItem from './components/InventoryItem.js';
import { readItemForm, syncPieceField } from './itemForm.js';

const list = getElementByIdOrThrow('item_list');
const error = getElementByIdOrThrow<HTMLParagraphElement>('inventory_error');
const filter = getElementByIdOrThrow<HTMLSelectElement>('location_filter');
const addForm = getElementByIdOrThrow<HTMLFormElement>('add_item');

const openIds = new Set<number>();

filter.addEventListener('change', () => { void load(); });

const unit = addForm.elements.namedItem('unit');
if (unit instanceof HTMLSelectElement) {
  unit.addEventListener('change', () => syncPieceField(addForm));
}
syncPieceField(addForm);

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    clearError();
    const button = addForm.querySelector('button');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await api('/api/items', 'POST', readItemForm(addForm));
      addForm.reset();
      syncPieceField(addForm);
      await load();
    } catch (err) {
      showError(err);
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  })();
});

list.addEventListener('item-open', (event) => {
  const detail = (event as CustomEvent<{ id: number; open: boolean }>).detail;
  if (detail.open) openIds.add(detail.id);
  else openIds.delete(detail.id);
});

list.addEventListener('inventory-changed', (event) => {
  const detail = (event as CustomEvent<{ id: number; reopen: boolean }>).detail;
  if (detail.reopen) openIds.add(detail.id);
  else openIds.delete(detail.id);
  void load();
});

async function load() {
  clearError();
  const location = filter.value;
  const path = location ? `/api/items?location=${encodeURIComponent(location)}` : '/api/items';
  try {
    const items = await api<ItemSummary[]>(path);
    list.replaceChildren();
    if (items.length === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = location
        ? 'Nothing on hand in that place.'
        : 'No items yet. Add what you keep in the house.';
      list.append(note);
      return;
    }
    for (const item of items) {
      list.append(InventoryItem.create(item, openIds.has(item.id)));
    }
  } catch (err) {
    showError(err);
  }
}

function clearError() {
  error.hidden = true;
  error.textContent = '';
}

function showError(err: unknown) {
  error.hidden = false;
  error.textContent = err instanceof Error ? err.message : 'Something went wrong.';
}

void load();
