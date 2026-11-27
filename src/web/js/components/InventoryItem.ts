import type { ItemDetail, ItemSummary, LotInfo, Source } from '../../../types.js';
import { api, formatCad, formatPer100g, formatQty, getIsoDate, showFigure } from '../common.js';
import { fillItemForm, readItemForm, syncPieceField } from '../itemForm.js';

export default class InventoryItem extends HTMLElement {
  #item!: ItemSummary;
  #startOpen = false;
  #request = 0;

  connectedCallback() {
    if (!this.hasChildNodes()) this.render();
  }

  static create(item: ItemSummary, startOpen = false) {
    const node = document.createElement('inventory-item') as InventoryItem;
    node.#item = item;
    node.#startOpen = startOpen;
    return node;
  }

  render() {
    this.replaceChildren();
    const details = document.createElement('details');
    const slot = document.createElement('div');
    slot.className = 'item-body';
    details.append(this.summary(), slot);
    details.addEventListener('toggle', () => {
      this.dispatchEvent(new CustomEvent('item-open', {
        bubbles: true,
        detail: { id: this.#item.id, open: details.open },
      }));
      if (details.open) void this.fill(slot);
    });
    this.append(details);
    if (this.#startOpen) details.open = true;
  }

  summary() {
    const summary = document.createElement('summary');
    // Spans, not divs: summary only allows phrasing content, and iOS Safari is picky about that.
    summary.append(el('span', 'item-name', this.#item.name));
    const marks = badges(this.#item);
    if (marks) summary.append(marks);
    summary.append(el('span', 'line', `On hand ${formatQty(this.#item.on_hand, this.#item.unit)}`));
    const levels = stockLevels(this.#item);
    if (levels) summary.append(el('span', 'line muted', levels));
    summary.append(el('span', 'line muted', placeLine(this.#item)));
    const price = el('span', 'line muted', '');
    showFigure(
      price,
      this.#item.latest_store_unit_price_per_g,
      this.#item.latest_store_unit_price_per_g == null
        ? 'No store price yet'
        : `Latest store ${formatPer100g(this.#item.latest_store_unit_price_per_g)}`,
    );
    summary.append(price);
    return summary;
  }

  async fill(slot: HTMLElement) {
    const request = ++this.#request;
    slot.replaceChildren(el('p', 'note', 'Loading…'));
    try {
      const item = await api<ItemDetail>(`/api/items/${this.#item.id}`);
      if (request !== this.#request) return;
      this.#item = item;
      const report = (err: unknown) => showError(slot, err);
      const edit = document.createElement('details');
      edit.append(el('summary', '', 'Edit item'), this.editor(item, report));
      slot.replaceChildren(
        statusBlock(item),
        el('h3', '', 'Lots'),
        ...item.lots.map(lot => lotBlock(item, lot, () => this.saved(), report)),
        addLotForm(item, () => this.saved(), report),
        el('h3', '', 'Stock count'),
        countForm(item, () => this.saved(), report),
        edit,
      );
    } catch (err) {
      if (request !== this.#request) return;
      slot.replaceChildren();
      showError(slot, err);
    }
  }

  editor(item: ItemDetail, report: (err: unknown) => void) {
    const wrap = el('div', '');
    const template = document.getElementById('add_item');
    if (!(template instanceof HTMLFormElement)) {
      wrap.append(el('p', 'error', 'The add-item form is missing, so this item cannot be edited here.'));
      return wrap;
    }
    const form = template.cloneNode(true) as HTMLFormElement;
    form.removeAttribute('id');
    const button = form.querySelector('button');
    if (button) button.textContent = 'Save item';
    fillItemForm(form, item);
    const unit = form.elements.namedItem('unit');
    if (unit instanceof HTMLSelectElement) {
      unit.addEventListener('change', () => syncPieceField(form));
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitEditor(form, item, report);
    });
    const remove = el('button', '', 'Delete item') as HTMLButtonElement;
    remove.type = 'button';
    remove.addEventListener('click', () => { void this.deleteItem(item, report); });
    wrap.append(form, remove);
    return wrap;
  }

  async submitEditor(form: HTMLFormElement, item: ItemDetail, report: (err: unknown) => void) {
    const button = form.querySelector('button');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await api(`/api/items/${item.id}`, 'PUT', readItemForm(form));
      this.saved();
    } catch (err) {
      report(err);
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  }

  async deleteItem(item: ItemDetail, report: (err: unknown) => void) {
    if (!confirm(`Delete ${item.name}? Lots have to be removed first.`)) return;
    try {
      await api(`/api/items/${item.id}`, 'DELETE');
      this.dispatchEvent(new CustomEvent('inventory-changed', {
        bubbles: true,
        detail: { id: item.id, reopen: false },
      }));
    } catch (err) {
      report(err);
    }
  }

  saved() {
    this.dispatchEvent(new CustomEvent('inventory-changed', {
      bubbles: true,
      detail: { id: this.#item.id, reopen: true },
    }));
  }
}

customElements.define('inventory-item', InventoryItem);

function statusBlock(item: ItemDetail) {
  const box = el('div', 'status');
  // The summary above already shows on-hand, places, and the latest price.
  if (item.reserved) {
    box.append(el('p', '', `Reserved ${formatQty(item.reserved, item.unit)} · available ${formatQty(item.available, item.unit)}`));
  }
  const average = el('p', 'muted', '');
  showFigure(
    average,
    item.average_store_unit_price_per_g,
    `Average store price ${formatPer100g(item.average_store_unit_price_per_g)}`,
  );
  box.append(average, el('p', 'muted', `${item.kcal_per_100g} kcal / 100 g`));
  return box;
}

function lotBlock(item: ItemDetail, lot: LotInfo, onChange: () => void, report: (err: unknown) => void) {
  const box = el('div', 'lot');
  const title = el('p', '');
  title.append(el('strong', '', `${placeName(lot.location)} · ${lot.source === 'store' ? 'Store' : 'Homestead'}`));
  if (lot.use_soon) title.append(' ', el('span', 'badge', 'Use soon'));
  box.append(title);

  let when = `Added ${lot.added_on}`;
  if (lot.expiry) when += lot.expiry < getIsoDate() ? ` · expired ${lot.expiry}` : ` · expires ${lot.expiry}`;
  box.append(el('p', 'muted', when));

  if (lot.location === 'freezer') {
    const grams = lot.packages.reduce((sum, pkg) => sum + pkg.weight_g, 0);
    const bought = lot.package_count ?? lot.packages.length;
    box.append(el('p', '', `${formatQty(lot.packages.length, 'package')} left of ${bought}, ${formatQty(grams, 'g')} still frozen`));
    const average = lot.package_count ? lot.total_g / lot.package_count : 0;
    box.append(el('p', 'muted', `Bought ${formatQty(lot.total_g, 'g')} · average ${formatQty(average, 'g')}`));
  } else {
    const qty = lot.quantity ?? 0;
    let line = `${formatQty(qty, item.unit)} on hand`;
    if (item.unit === 'piece' && item.grams_per_piece) {
      line += ` (${formatQty(qty * item.grams_per_piece, 'g')})`;
    }
    box.append(el('p', '', line));
  }

  const cost = el('p', '');
  if (lot.source === 'homestead' || lot.total_price == null) {
    cost.className = 'muted';
    cost.textContent = lot.source === 'homestead' ? 'Homestead · left out of cost figures' : 'No price recorded';
  } else {
    let line = `${formatCad(lot.total_price)} paid · ${formatPer100g(lot.unit_price_per_g)}`;
    if (lot.unit_price_per_package != null) line += ` · ${formatCad(lot.unit_price_per_package)} / package`;
    showFigure(cost, lot.total_price, line);
  }
  box.append(cost);

  if (lot.location === 'freezer') box.append(packageEditor(item, lot, onChange, report));

  const correct = document.createElement('details');
  correct.append(el('summary', '', 'Correct this lot'), lotForm(item, lot, onChange, report));
  box.append(correct);

  const remove = el('button', '', 'Remove lot') as HTMLButtonElement;
  remove.type = 'button';
  remove.addEventListener('click', () => {
    if (!confirm('Remove this lot?')) return;
    void (async () => {
      try {
        await api(`/api/items/${item.id}/lots/${lot.id}`, 'DELETE');
        onChange();
      } catch (err) {
        report(err);
      }
    })();
  });
  box.append(remove);
  return box;
}

function packageEditor(item: ItemDetail, lot: LotInfo, onChange: () => void, report: (err: unknown) => void) {
  const wrap = el('div', 'packages');
  if (lot.packages.length === 0) {
    wrap.append(el('p', 'note', 'No packages left in this lot.'));
    return wrap;
  }
  wrap.append(el('p', 'note', 'Type a package weight if you weighed it. Leave the average if you did not.'));
  const shown = lot.packages.slice(0, 24);
  shown.forEach((pkg, index) => {
    const form = el('form', 'package') as HTMLFormElement;
    const weight = numberInput(String(round1(pkg.weight_g)));
    weight.setAttribute('aria-label', `Package ${index + 1} grams`);
    const save = el('button', '', 'Save') as HTMLButtonElement;
    save.type = 'submit';
    form.append(el('span', '', `${index + 1}.`), weight, el('span', '', 'g'), save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const grams = Number(weight.value);
      if (!(grams > 0)) {
        report(new Error('Package weight must be greater than zero.'));
        return;
      }
      save.disabled = true;
      void (async () => {
        try {
          await api(`/api/items/${item.id}/lots/${lot.id}/packages/${pkg.id}`, 'PUT', { weight_g: grams });
          onChange();
        } catch (err) {
          report(err);
          save.disabled = false;
        }
      })();
    });
    wrap.append(form);
  });
  if (lot.packages.length > shown.length) {
    wrap.append(el('p', 'note', `Showing 24 of ${lot.packages.length} packages.`));
  }
  return wrap;
}

function addLotForm(item: ItemDetail, onChange: () => void, report: (err: unknown) => void) {
  const wrap = el('div', '');
  wrap.append(el('h3', '', 'Add a lot'));
  wrap.append(lotForm(item, null, onChange, report));
  return wrap;
}

function lotForm(item: ItemDetail, lot: LotInfo | null, onChange: () => void, report: (err: unknown) => void) {
  const form = el('form', 'form') as HTMLFormElement;
  form.autocomplete = 'off';
  const adding = lot == null;
  const location = locationControl(
    lot?.location ?? 'pantry',
    adding || lot.location === 'freezer',
    lot != null && lot.location === 'freezer',
  );
  const source = select([
    { value: 'store', label: 'Store' },
    { value: 'homestead', label: 'Homestead' },
  ], lot?.source ?? 'store');
  const date = document.createElement('input');
  date.type = 'date';
  date.value = lot?.added_on ?? getIsoDate();
  const price = numberInput(lot?.total_price == null ? '' : String(lot.total_price));
  price.step = '0.01';
  const grams = numberInput(lot ? String(round1(lot.total_g)) : '');
  const pieces = numberInput(lot?.quantity == null ? '' : String(lot.quantity));
  const packages = numberInput(lot?.package_count == null ? '' : String(lot.package_count));
  packages.step = '1';
  packages.inputMode = 'numeric';
  if (!adding) packages.disabled = true;

  const priceLabel = labeled('Total price (CAD)', price);
  const gramsLabel = labeled(adding ? 'Total grams' : 'Total grams bought', grams);
  const piecesLabel = labeled('Pieces', pieces);
  const packagesLabel = labeled('Packages', packages);
  // A stock count changes what's left without rewriting the purchase.
  // Saving "correct" must not put that amount back.
  const keepAmount = lot != null && looseWasCounted(item, lot);
  if (!adding && lot.location === 'freezer') {
    packagesLabel.append(el('span', 'note', ' Delete the lot to change the package count.'));
  }

  const sync = () => {
    const freezer = location.isFreezer();
    const pieceItem = item.unit === 'piece';
    priceLabel.hidden = source.value === 'homestead';
    gramsLabel.hidden = keepAmount || (!freezer && pieceItem);
    piecesLabel.hidden = keepAmount || freezer || !pieceItem;
    packagesLabel.hidden = keepAmount || !freezer;
  };
  source.addEventListener('change', sync);
  location.picker.addEventListener('change', sync);
  sync();

  const button = el('button', '', adding ? 'Add lot' : 'Save lot') as HTMLButtonElement;
  button.type = 'submit';
  form.append(
    ...location.nodes,
    labeled('Source', source),
    labeled('Date added', date),
    priceLabel,
    gramsLabel,
    piecesLabel,
    packagesLabel,
  );
  if (keepAmount) {
    form.append(el('p', 'note', 'A stock count set what is left, so this does not change the amount. Remove the lot and add it again if the purchase amount was wrong.'));
  }
  form.append(button);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      button.disabled = true;
      try {
        const where = location.read();
        const chosen = source.value === 'homestead' ? 'homestead' : 'store';
        const body = lotBody(item, where, chosen, date.value, price, grams, pieces, packages, adding, keepAmount);
        const path = adding ? `/api/items/${item.id}/lots` : `/api/items/${item.id}/lots/${lot.id}`;
        await api(path, adding ? 'POST' : 'PUT', body);
        onChange();
      } catch (err) {
        report(err);
        button.disabled = false;
      }
    })();
  });
  return form;
}

function lotBody(
  item: ItemDetail,
  location: string,
  source: Source,
  addedOn: string,
  price: HTMLInputElement,
  grams: HTMLInputElement,
  pieces: HTMLInputElement,
  packages: HTMLInputElement,
  adding: boolean,
  keepAmount: boolean,
) {
  const body: Record<string, unknown> = {
    location,
    source,
    added_on: addedOn,
    total_price: source === 'store' ? readOptional(price, 'Total price') : null,
  };
  if (keepAmount && location !== 'freezer') return body;
  if (location === 'freezer') {
    const totalG = readRequired(grams, 'Total grams');
    body.total_g = totalG;
    if (adding) body.package_count = readRequired(packages, 'Package count');
    return body;
  }
  if (item.unit === 'piece') {
    body.quantity = readRequired(pieces, 'Pieces');
    return body;
  }
  const totalG = readRequired(grams, 'Total grams');
  body.total_g = totalG;
  body.quantity = totalG;
  return body;
}

function countForm(item: ItemDetail, onChange: () => void, report: (err: unknown) => void) {
  const form = el('form', 'form') as HTMLFormElement;
  const known = ['pantry', 'fridge', 'freezer'];
  for (const lot of item.lots) {
    if (!known.includes(lot.location)) known.push(lot.location);
  }
  const location = locationControl('pantry', true, false, known);
  const quantity = numberInput('');
  const source = select([
    { value: 'store', label: 'Store' },
    { value: 'homestead', label: 'Homestead' },
  ], 'store');
  const amountLabel = labeled('Amount counted', quantity);
  const sourceLabel = labeled('Source for stock you found', source);
  const sync = () => {
    sourceLabel.hidden = location.isFreezer();
    const name = amountLabel.firstChild;
    if (name) name.textContent = location.isFreezer() ? 'Packages counted' : 'Amount counted';
  };
  location.picker.addEventListener('change', sync);
  sync();

  const button = el('button', '', 'Save count') as HTMLButtonElement;
  button.type = 'submit';
  form.append(
    ...location.nodes,
    amountLabel,
    sourceLabel,
    el('p', 'note', 'This is the source of truth. A lower count takes the difference off the oldest, soonest-expiring lots. A higher count adds a lot dated today. A freezer count is packages, added to the newest freezer lot at its average weight.'),
    button,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      button.disabled = true;
      try {
        const where = location.read();
        const amount = readRequired(quantity, 'Counted amount');
        if (where === 'freezer' && !Number.isInteger(amount)) {
          throw new Error('A freezer count is a whole number of packages.');
        }
        await api(`/api/items/${item.id}/count`, 'PUT', {
          quantity: amount,
          location: where,
          source: source.value === 'homestead' ? 'homestead' : 'store',
        });
        onChange();
      } catch (err) {
        report(err);
        button.disabled = false;
      }
    })();
  });
  return form;
}

function locationControl(selected: string, allowFreezer: boolean, lockFreezer: boolean, extra: string[] = []) {
  const choices: Array<{ value: string; label: string }> = [
    { value: 'pantry', label: 'Pantry' },
    { value: 'fridge', label: 'Fridge' },
  ];
  if (allowFreezer) choices.push({ value: 'freezer', label: 'Freezer' });
  for (const place of extra) {
    if (!choices.some(choice => choice.value === place)) {
      choices.push({ value: place, label: placeName(place) });
    }
  }
  choices.push({ value: 'other', label: 'Other' });
  const known = choices.some(choice => choice.value === selected);
  const picker = select(choices, known ? selected : 'other');
  if (lockFreezer) picker.disabled = true;
  const other = document.createElement('input');
  other.type = 'text';
  other.maxLength = 40;
  other.placeholder = 'Spice rack';
  other.value = known ? '' : selected;
  const otherLabel = labeled('Where', other);
  const sync = () => { otherLabel.hidden = picker.value !== 'other'; };
  picker.addEventListener('change', sync);
  sync();
  return {
    picker,
    nodes: [labeled('Location', picker), otherLabel],
    isFreezer: () => picker.value === 'freezer',
    read(): string {
      if (picker.value !== 'other') return picker.value;
      const name = other.value.trim();
      if (!name) throw new Error('Type a location.');
      return name;
    },
  };
}

function looseWasCounted(item: ItemDetail, lot: LotInfo): boolean {
  if (lot.location === 'freezer') return false;
  if (item.unit === 'piece') {
    const grams = (lot.quantity ?? 0) * (item.grams_per_piece ?? 0);
    return Math.abs(grams - lot.total_g) > 0.05;
  }
  return Math.abs((lot.quantity ?? 0) - lot.total_g) > 0.05;
}

function stockLevels(item: ItemSummary): string {
  const bits: string[] = [];
  if (item.min_stock != null) bits.push(`min ${formatQty(item.min_stock, item.unit)}`);
  if (item.max_stock != null) bits.push(`max ${formatQty(item.max_stock, item.unit)}`);
  if (item.use_per_day != null) bits.push(`about ${formatQty(item.use_per_day, item.unit)}/day`);
  return bits.join(' · ');
}

function badges(item: ItemSummary) {
  const row = el('span', 'badges');
  if (item.use_soon) row.append(el('span', 'badge', 'Use soon'));
  if (item.below_min) row.append(el('span', 'badge warn', 'Below min'));
  if (item.above_max) row.append(el('span', 'badge', 'Above max'));
  return row.childNodes.length > 0 ? row : null;
}

function placeLine(item: ItemSummary): string {
  if (item.on_hand_by_location.length === 0) return 'Nothing on hand.';
  return item.on_hand_by_location.map(place => {
    if (place.unit === 'package') {
      return `${placeName(place.location)} ${formatQty(place.quantity, 'package')} (${formatQty(place.grams, 'g')})`;
    }
    const grams = place.unit === 'piece' ? ` (${formatQty(place.grams, 'g')})` : '';
    return `${placeName(place.location)} ${formatQty(place.quantity, place.unit)}${grams}`;
  }).join(' · ');
}

function placeName(location: string): string {
  if (location === 'pantry' || location === 'fridge' || location === 'freezer') {
    return location.charAt(0).toUpperCase() + location.slice(1);
  }
  return location;
}

function showError(slot: HTMLElement, err: unknown) {
  let node = slot.querySelector('.error');
  if (!(node instanceof HTMLElement)) {
    node = el('p', 'error', '');
    slot.prepend(node);
  }
  node.textContent = err instanceof Error ? err.message : 'Something went wrong.';
}

function readRequired(input: HTMLInputElement, label: string): number {
  const n = readOptional(input, label);
  if (n == null) throw new Error(`${label} is required.`);
  return n;
}

function readOptional(input: HTMLInputElement, label: string): number | null {
  if (input.value.trim() === '') return null;
  const n = Number(input.value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
  return n;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function numberInput(value: string) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.inputMode = 'decimal';
  input.value = value;
  return input;
}

function select(options: Array<{ value: string; label: string }>, selected: string) {
  const node = document.createElement('select');
  for (const option of options) {
    const elOption = document.createElement('option');
    elOption.value = option.value;
    elOption.textContent = option.label;
    if (option.value === selected) elOption.selected = true;
    node.append(elOption);
  }
  return node;
}

function labeled(text: string, control: HTMLElement) {
  const label = document.createElement('label');
  label.append(text, control);
  return label;
}

function el(tag: string, className: string, text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
