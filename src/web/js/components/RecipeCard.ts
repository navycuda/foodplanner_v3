import type { RecipeDetail, RecipeSummary } from '../../../types.js';
import { api, formatQty } from '../common.js';
import { fillIngredientHost, readIngredientHost, type ItemChoice } from '../recipeForm.js';
import { cookedGramsForPackage, formatKcal, formatPercent, previewRecipe } from '../recipeMath.js';

export default class RecipeCard extends HTMLElement {
  #recipe!: RecipeSummary;
  #items!: ItemChoice[];
  #startOpen = false;
  #request = 0;

  connectedCallback() {
    if (!this.hasChildNodes()) this.render();
  }

  static create(recipe: RecipeSummary, items: ItemChoice[], startOpen = false) {
    const node = document.createElement('recipe-card') as RecipeCard;
    node.#recipe = recipe;
    node.#items = items;
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
      this.dispatchEvent(new CustomEvent('recipe-open', {
        bubbles: true,
        detail: { id: this.#recipe.id, open: details.open },
      }));
      if (details.open) void this.fill(slot);
    });
    this.append(details);
    if (this.#startOpen) details.open = true;
  }

  summary() {
    const summary = document.createElement('summary');
    summary.append(el('span', 'item-name', this.#recipe.name));
    const marks = el('span', 'badges');
    if (this.#recipe.use_soon) marks.append(el('span', 'badge', 'Use soon'));
    marks.append(el('span', this.#recipe.can_make ? 'badge ok' : 'badge warn', this.#recipe.can_make ? 'Can make' : 'Need stock'));
    if (marks.childNodes.length > 0) summary.append(marks);
    summary.append(el('span', 'line', `${trim(this.#recipe.cooked_yield_g)} g cooked · ${formatKcal(this.#recipe.kcal)}`));
    summary.append(el('span', 'line muted', `${formatKcal(this.#recipe.kcal_per_100g)} / 100 g`));
    return summary;
  }

  async fill(slot: HTMLElement) {
    const request = ++this.#request;
    slot.replaceChildren(el('p', 'note', 'Loading…'));
    try {
      const recipe = await api<RecipeDetail>(`/api/recipes/${this.#recipe.id}`);
      if (request !== this.#request) return;
      this.#recipe = recipe;
      slot.replaceChildren(this.body(recipe));
    } catch (err) {
      if (request !== this.#request) return;
      slot.replaceChildren();
      const message = el('p', 'error', err instanceof Error ? err.message : 'Could not load this recipe.');
      slot.append(message);
    }
  }

  body(recipe: RecipeDetail) {
    const wrap = document.createElement('div');
    if (recipe.notes) wrap.append(el('p', 'note', recipe.notes));
    wrap.append(el('p', 'note', 'Percents are raw grams over the cooked yield, so they do not add to 100.'));
    for (const line of recipe.ingredients) {
      const row = el('p', '');
      let text = `${line.name}: ${formatQty(line.quantity, line.unit)}`;
      if (line.unit === 'piece') text += ` (${formatQty(line.grams, 'g')})`;
      text += ` · ${formatKcal(line.kcal)} · ${formatPercent(line.ww_percent)}`;
      row.textContent = text;
      if (line.use_soon) row.append(' ', el('span', 'badge', 'Use soon'));
      wrap.append(row);
    }
    wrap.append(this.preview(recipe), this.editor(recipe));
    return wrap;
  }

  preview(recipe: RecipeDetail) {
    const box = el('div', 'preview');
    box.append(el('h3', '', 'If I want'));
    const grams = document.createElement('input');
    grams.type = 'number';
    grams.min = '0';
    grams.step = 'any';
    grams.inputMode = 'decimal';
    grams.value = String(recipe.cooked_yield_g);
    const result = el('div', '');
    const packageSelect = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'No package — use the weight above';
    packageSelect.append(blank);
    for (const line of recipe.ingredients) {
      for (const pkg of line.freezer_packages) {
        const option = document.createElement('option');
        option.value = String(pkg.id);
        option.dataset.weight = String(pkg.weight_g);
        option.dataset.item = String(line.item_id);
        option.dataset.grams = String(line.grams);
        option.textContent = `${line.name}, ${trim(pkg.weight_g)} g`;
        packageSelect.append(option);
      }
    }
    const draw = () => {
      result.replaceChildren();
      const requested = Number(grams.value);
      if (!Number.isFinite(requested) || !(requested > 0)) {
        result.append(el('p', 'error', 'Ask for a cooked weight greater than zero.'));
        return;
      }
      const view = previewRecipe(recipe.cooked_yield_g, requested, recipe.ingredients.map(line => ({
        name: line.name,
        unit: line.unit,
        quantity: line.quantity,
        gramsPerPiece: line.grams_per_piece,
        kcalPer100g: line.kcal_per_100g,
        available: line.available,
        useSoon: line.use_soon,
      })));
      const heading = el('p', '');
      heading.textContent = `${trim(requested)} g cooked · ${formatKcal(view.portionKcal)}`;
      result.append(heading);
      for (const line of view.lines) {
        const row = el('p', line.enough ? '' : 'negative');
        let text = `${line.name}: ${formatQty(line.scaledQuantity, line.unit)}`;
        if (line.unit === 'piece') text += ` (${formatQty(line.scaledGrams, 'g')})`;
        text += line.enough
          ? ` · have ${formatQty(line.available, line.unit)}`
          : ` · short ${formatQty(line.shortBy, line.unit)}`;
        row.textContent = text;
        result.append(row);
      }
      const verdict = el('p', view.canMake ? '' : 'negative');
      verdict.textContent = view.canMake
        ? 'Can make this from what is in the house.'
        : 'Not enough in the house. The short items would go on the grocery list.';
      result.append(verdict);
    };
    packageSelect.addEventListener('change', () => {
      const option = packageSelect.selectedOptions[0];
      if (!option || option.value === '') {
        draw();
        return;
      }
      const weight = Number(option.dataset.weight);
      const lineG = Number(option.dataset.grams);
      const cooked = cookedGramsForPackage(recipe.cooked_yield_g, lineG, weight);
      grams.value = String(Math.round(cooked * 10) / 10);
      draw();
      const note = el('p', 'note', `Thawing ${trim(weight)} g sets the batch to ${trim(cooked)} g cooked.`);
      result.prepend(note);
    });
    grams.addEventListener('input', () => {
      packageSelect.value = '';
      draw();
    });
    box.append(labeled('Cooked grams', grams));
    if (packageSelect.options.length > 1) box.append(labeled('Or thaw a package', packageSelect));
    box.append(result);
    draw();
    return box;
  }

  editor(recipe: RecipeDetail) {
    const details = document.createElement('details');
    const form = document.createElement('form');
    form.className = 'form';
    form.autocomplete = 'off';
    const host = document.createElement('div');
    fillIngredientHost(host, this.#items, recipe.ingredients.map(line => ({
      item_id: line.item_id,
      quantity: line.quantity,
    })));
    const save = el('button', '', 'Save recipe') as HTMLButtonElement;
    save.type = 'submit';
    form.append(
      labeled('Name', textInput('name', recipe.name)),
      labeled('Cooked yield (g)', numberInput('cooked_yield_g', String(recipe.cooked_yield_g))),
      labeled('Notes', textInput('notes', recipe.notes ?? '')),
      host,
      save,
    );
    const report = el('p', 'error', '');
    report.hidden = true;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.save(form, host, recipe, report, save);
    });
    const remove = el('button', '', 'Delete recipe') as HTMLButtonElement;
    remove.type = 'button';
    remove.addEventListener('click', () => { void this.deleteRecipe(recipe); });
    details.append(el('summary', '', 'Edit recipe'), form, report, remove);
    return details;
  }

  async save(form: HTMLFormElement, host: HTMLElement, recipe: RecipeDetail, report: HTMLElement, button: HTMLButtonElement) {
    report.hidden = true;
    button.disabled = true;
    try {
      const name = valueOf(form, 'name').trim();
      if (!name) throw new Error('Name is required.');
      const cooked = Number(valueOf(form, 'cooked_yield_g'));
      if (!Number.isFinite(cooked) || !(cooked > 0)) throw new Error('Cooked yield must be greater than zero.');
      const notes = valueOf(form, 'notes').trim();
      await api(`/api/recipes/${recipe.id}`, 'PUT', {
        name,
        cooked_yield_g: cooked,
        notes: notes === '' ? null : notes,
        ingredients: readIngredientHost(host),
      });
      this.dispatchEvent(new CustomEvent('recipe-changed', {
        bubbles: true,
        detail: { id: recipe.id, reopen: true },
      }));
    } catch (err) {
      report.hidden = false;
      report.textContent = err instanceof Error ? err.message : 'Could not save.';
      button.disabled = false;
    }
  }

  async deleteRecipe(recipe: RecipeDetail) {
    if (!confirm(`Delete ${recipe.name}?`)) return;
    try {
      await api(`/api/recipes/${recipe.id}`, 'DELETE');
      this.dispatchEvent(new CustomEvent('recipe-changed', {
        bubbles: true,
        detail: { id: recipe.id, reopen: false },
      }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not delete.');
    }
  }
}

customElements.define('recipe-card', RecipeCard);

function valueOf(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement ? element.value : '';
}

function textInput(name: string, value: string) {
  const input = document.createElement('input');
  input.name = name;
  input.value = value;
  input.maxLength = name === 'notes' ? 200 : 80;
  return input;
}

function numberInput(name: string, value: string) {
  const input = document.createElement('input');
  input.name = name;
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.inputMode = 'decimal';
  input.value = value;
  return input;
}

function labeled(text: string, control: HTMLElement) {
  const label = document.createElement('label');
  label.append(text, control);
  return label;
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function el(tag: string, className: string, text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
