import type { Unit } from '../../types.js';
import { api, formatCad, formatQty, getElementByIdOrThrow, showFigure } from './common.js';

type ShoppingLine = {
  id: number;
  item_id: number | null;
  name: string;
  quantity: number;
  unit: Unit;
  checked: number;
  source: 'manual' | 'generated';
  estimated_cost: number | null;
};

type ShoppingList = {
  lines: ShoppingLine[];
  total: number;
};

export function mountShopping() {
  const list = getElementByIdOrThrow('shopping_list');
  const total = getElementByIdOrThrow('shopping_total');
  const error = getElementByIdOrThrow<HTMLParagraphElement>('shopping_error');
  const generate = getElementByIdOrThrow<HTMLButtonElement>('shopping_generate');
  const form = getElementByIdOrThrow<HTMLFormElement>('shopping_add');

  const showError = (err: unknown) => {
    error.hidden = false;
    error.textContent = err instanceof Error ? err.message : 'Could not update the list.';
  };

  const render = (body: ShoppingList) => {
    error.hidden = true;
    total.replaceChildren();
    const label = document.createElement('span');
    label.textContent = 'Total ';
    const amount = document.createElement('span');
    showFigure(amount, body.total, formatCad(body.total));
    total.append(label, amount);
    list.replaceChildren();
    if (body.lines.length === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'Nothing to buy.';
      list.append(note);
      return;
    }
    for (const line of body.lines) list.append(renderLine(line, showError, () => { void refresh(false); }));
  };

  const refresh = async (rebuild: boolean) => {
    try {
      const body = rebuild
        ? await api<ShoppingList>('/api/shopping/generate', 'POST')
        : await api<ShoppingList>('/api/shopping');
      render(body);
    } catch (err) {
      showError(err);
    }
  };

  generate.addEventListener('click', () => { void refresh(true); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      try {
        const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
        const quantity = Number((form.elements.namedItem('quantity') as HTMLInputElement).value);
        const unit = (form.elements.namedItem('unit') as HTMLSelectElement).value;
        if (!name) throw new Error('Name is required.');
        if (!Number.isFinite(quantity) || !(quantity > 0)) throw new Error('Quantity must be greater than zero.');
        await api('/api/shopping', 'POST', { name, quantity, unit });
        form.reset();
        await refresh(false);
      } catch (err) {
        showError(err);
      }
    })();
  });

  void refresh(true);
}

function renderLine(line: ShoppingLine, showError: (err: unknown) => void, reload: () => void) {
  const row = document.createElement('div');
  row.className = line.checked ? 'shop-line checked' : 'shop-line';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = line.checked === 1;
  box.addEventListener('change', () => {
    void api(`/api/shopping/${line.id}`, 'PUT', { checked: box.checked ? 1 : 0 })
      .then(reload)
      .catch(err => {
        box.checked = !box.checked;
        showError(err);
      });
  });
  const text = document.createElement('div');
  const name = document.createElement('div');
  name.textContent = `${line.name} · ${formatQty(line.quantity, line.unit)}`;
  if (line.source === 'manual') name.textContent += ' · extra';
  const cost = document.createElement('div');
  cost.className = 'muted';
  if (line.estimated_cost == null) cost.textContent = 'No store price';
  else showFigure(cost, line.estimated_cost, formatCad(line.estimated_cost));
  text.append(name, cost);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    void api(`/api/shopping/${line.id}`, 'DELETE').then(reload).catch(showError);
  });
  row.append(box, text, remove);
  if (line.item_id != null) row.append(boughtForm(line, showError, reload));
  return row;
}

function boughtForm(line: ShoppingLine, showError: (err: unknown) => void, reload: () => void) {
  const details = document.createElement('details');
  const form = document.createElement('form');
  form.className = 'form';
  const location = document.createElement('select');
  for (const place of ['pantry', 'fridge', 'freezer']) {
    const option = document.createElement('option');
    option.value = place;
    option.textContent = place.charAt(0).toUpperCase() + place.slice(1);
    location.append(option);
  }
  const price = numberInput('0.01');
  const amount = numberInput('any');
  amount.value = String(line.quantity);
  const packages = numberInput('1');
  const packageLabel = labeled('Packages', packages);
  const amountTitle = document.createElement('span');
  const sync = () => {
    packageLabel.hidden = location.value !== 'freezer';
    amountTitle.textContent = location.value === 'freezer' || line.unit === 'g' ? 'Grams' : 'Pieces';
  };
  location.addEventListener('change', sync);
  sync();
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Add to stock';
  form.append(
    labeled('Where', location),
    labeled('Price paid (CAD)', price),
    labeledNode(amountTitle, amount),
    packageLabel,
    save,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      save.disabled = true;
      try {
        const paid = price.value.trim() === '' ? null : Number(price.value);
        const qty = Number(amount.value);
        if (!Number.isFinite(qty) || !(qty > 0)) throw new Error('Amount must be greater than zero.');
        const body: Record<string, unknown> = {
          location: location.value,
          source: 'store',
          total_price: paid,
          added_on: undefined,
        };
        if (location.value === 'freezer') {
          const count = Number(packages.value);
          if (!Number.isInteger(count) || count <= 0) throw new Error('Package count must be a whole number.');
          body.total_g = qty;
          body.package_count = count;
        } else if (line.unit === 'piece') {
          body.quantity = qty;
        } else {
          body.total_g = qty;
          body.quantity = qty;
        }
        delete body.added_on;
        await api(`/api/items/${line.item_id}/lots`, 'POST', body);
        await api(`/api/shopping/${line.id}`, 'PUT', { checked: 1 });
        reload();
      } catch (err) {
        showError(err);
        save.disabled = false;
      }
    })();
  });
  details.append(el('summary', 'Add what I bought'), form);
  return details;
}

function numberInput(step: string) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = step;
  input.inputMode = 'decimal';
  return input;
}

function labeled(text: string, control: HTMLElement) {
  const label = document.createElement('label');
  label.append(text, control);
  return label;
}

function labeledNode(title: HTMLElement, control: HTMLElement) {
  const label = document.createElement('label');
  label.append(title, control);
  return label;
}

function el(tag: string, text: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
