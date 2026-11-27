import type { MealType, PlanDish, RecipeDetail, RecipeSummary } from '../../../types.js';
import { api, formatQty, getDayName, getIsoDate } from '../common.js';
import { cookedGramsForPackage, formatKcal } from '../recipeMath.js';

const MEALS: Array<{ value: MealType; label: string }> = [
  { value: 'candy', label: 'Candy' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'for_stock', label: 'For Stock' },
];

export default class PlannerDay extends HTMLElement {
  #date!: Date;
  #entries: PlanDish[] = [];
  #recipes: RecipeSummary[] = [];
  #today = '';

  connectedCallback() {
    if (!this.hasChildNodes()) this.render();
  }

  static create(date: Date, entries: PlanDish[], recipes: RecipeSummary[], today: string) {
    const node = document.createElement('planner-day') as PlannerDay;
    node.#date = date;
    node.#entries = entries;
    node.#recipes = recipes;
    node.#today = today;
    return node;
  }

  render() {
    this.replaceChildren();
    const iso = getIsoDate(this.#date);
    if (iso === this.#today) this.classList.add('today');
    const editable = iso >= this.#today;
    const dayKcal = this.#entries.reduce((sum, entry) => sum + entry.kcal, 0);

    const title = document.createElement('h3');
    title.textContent = getDayName(this.#date);
    const dateLine = document.createElement('h4');
    dateLine.textContent = iso;
    this.append(title, dateLine);
    if (this.#entries.length > 0) this.append(el('p', 'day-kcal', formatKcal(dayKcal)));
    if (!editable) this.append(el('p', 'note', 'This day has passed.'));

    for (const entry of this.#entries) this.append(this.dish(entry, editable));
    if (editable) this.append(this.addForm(iso));
  }

  dish(entry: PlanDish, editable: boolean) {
    const box = el('div', 'dish');
    const title = el('p', '');
    title.append(el('strong', '', `${mealLabel(entry.meal_type)} · ${entry.recipe_name}`));
    if (entry.use_soon) title.append(' ', el('span', 'badge', 'Use soon'));
    if (editable) {
      title.append(' ', el('span', entry.can_make ? 'badge ok' : 'badge warn', entry.can_make ? 'Can make' : 'Short'));
    }
    box.append(title);
    box.append(el('p', 'muted', `${trim(entry.quantity_g)} g cooked · ${formatKcal(entry.kcal)}`));
    if (entry.package) {
      box.append(el('p', 'note', `Thawed ${trim(entry.package.weight_g)} g of ${entry.package.item_name} sets this batch.`));
    } else if (entry.held_packages.length > 0) {
      const weights = entry.held_packages.map(pkg => `${trim(pkg.weight_g)} g ${pkg.item_name}`).join(', ');
      box.append(el('p', 'note', `Holds whole packages: ${weights}.`));
    }
    for (const gap of entry.shortfalls) {
      box.append(el('p', 'negative', `Short ${formatQty(gap.short_by, gap.unit)} ${gap.name}`));
    }
    if (editable) box.append(this.editForm(entry));
    return box;
  }

  editForm(entry: PlanDish) {
    const form = document.createElement('form');
    form.className = 'form';
    const meal = mealSelect(entry.meal_type);
    const grams = numberInput(String(trim(entry.quantity_g)));
    if (entry.package) grams.readOnly = true;
    const save = el('button', '', 'Save') as HTMLButtonElement;
    save.type = 'submit';
    const remove = el('button', '', 'Remove') as HTMLButtonElement;
    remove.type = 'button';
    form.append(labeled('Meal', meal), labeled('Cooked grams', grams), save, remove);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.saveDish(entry, meal.value, grams, save);
    });
    remove.addEventListener('click', () => { void this.removeDish(entry); });
    return form;
  }

  async saveDish(entry: PlanDish, meal: string, grams: HTMLInputElement, button: HTMLButtonElement) {
    button.disabled = true;
    try {
      const body: { meal_type: string; quantity_g?: number } = { meal_type: meal };
      if (!entry.package) {
        const quantity = Number(grams.value);
        if (!Number.isFinite(quantity) || !(quantity > 0)) throw new Error('Cooked grams must be greater than zero.');
        body.quantity_g = quantity;
      }
      await api(`/api/plan/${entry.id}`, 'PUT', body);
      this.changed();
    } catch (err) {
      this.showError(err);
      button.disabled = false;
    }
  }

  async removeDish(entry: PlanDish) {
    if (!confirm(`Remove ${entry.recipe_name}?`)) return;
    try {
      await api(`/api/plan/${entry.id}`, 'DELETE');
      this.changed();
    } catch (err) {
      this.showError(err);
    }
  }

  addForm(iso: string) {
    if (this.#recipes.length === 0) return el('p', 'note', 'Add a recipe before planning a dish.');
    const details = document.createElement('details');
    const form = document.createElement('form');
    form.className = 'form';
    const recipe = document.createElement('select');
    for (const item of this.#recipes) {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = item.name;
      recipe.append(option);
    }
    const meal = mealSelect('dinner');
    const grams = numberInput('');
    const packages = document.createElement('select');
    const packageLabel = labeled('Or thaw a package', packages);
    packageLabel.hidden = true;
    const hint = el('p', 'note', '');
    const add = el('button', '', 'Add dish') as HTMLButtonElement;
    add.type = 'submit';

    const loadRecipe = async () => {
      packages.replaceChildren();
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'No package — use the weight';
      packages.append(none);
      const detail = await api<RecipeDetail>(`/api/recipes/${recipe.value}`);
      grams.readOnly = false;
      grams.dataset.yield = String(detail.cooked_yield_g);
      grams.value = grams.dataset.yield;
      let any = false;
      for (const line of detail.ingredients) {
        for (const pkg of line.freezer_packages) {
          any = true;
          const option = document.createElement('option');
          option.value = String(pkg.id);
          option.dataset.weight = String(pkg.weight_g);
          option.dataset.grams = String(line.grams);
          option.textContent = `${line.name}, ${trim(pkg.weight_g)} g`;
          packages.append(option);
        }
      }
      packageLabel.hidden = !any;
      hint.textContent = '';
    };
    recipe.addEventListener('change', () => { void loadRecipe().catch(err => this.showError(err)); });
    packages.addEventListener('change', () => {
      const option = packages.selectedOptions[0];
      const yieldG = Number(grams.dataset.yield);
      if (!option || option.value === '') {
        grams.readOnly = false;
        if (Number.isFinite(yieldG) && yieldG > 0) grams.value = String(yieldG);
        hint.textContent = '';
        return;
      }
      const cooked = cookedGramsForPackage(
        yieldG,
        Number(option.dataset.grams),
        Number(option.dataset.weight),
      );
      grams.value = String(Math.round(cooked * 10) / 10);
      grams.readOnly = true;
      hint.textContent = `Thawing ${trim(Number(option.dataset.weight))} g sets the batch to ${trim(cooked)} g cooked.`;
    });

    form.append(labeled('Recipe', recipe), labeled('Meal', meal), labeled('Cooked grams', grams), packageLabel, hint, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.addDish(iso, recipe, meal, grams, packages, add);
    });
    details.append(el('summary', '', 'Add a dish'), form);
    queueMicrotask(() => { void loadRecipe().catch(err => this.showError(err)); });
    return details;
  }

  async addDish(
    iso: string,
    recipe: HTMLSelectElement,
    meal: HTMLSelectElement,
    grams: HTMLInputElement,
    packages: HTMLSelectElement,
    button: HTMLButtonElement,
  ) {
    button.disabled = true;
    try {
      const quantity = Number(grams.value);
      if (!Number.isFinite(quantity) || !(quantity > 0)) throw new Error('Cooked grams must be greater than zero.');
      const packageId = packages.value === '' ? null : Number(packages.value);
      await api('/api/plan', 'POST', {
        date: iso,
        recipe_id: Number(recipe.value),
        meal_type: meal.value,
        quantity_g: quantity,
        package_id: packageId,
      });
      this.changed();
    } catch (err) {
      this.showError(err);
      button.disabled = false;
    }
  }

  showError(err: unknown) {
    let node = this.querySelector('.error');
    if (!(node instanceof HTMLElement)) {
      node = el('p', 'error', '');
      this.append(node);
    }
    if (!(node instanceof HTMLElement)) return;
    node.hidden = false;
    node.textContent = err instanceof Error ? err.message : 'Could not save.';
  }

  changed() {
    this.dispatchEvent(new CustomEvent('plan-changed', { bubbles: true }));
  }
}

customElements.define('planner-day', PlannerDay);

function mealLabel(meal: MealType): string {
  return MEALS.find(row => row.value === meal)?.label ?? meal;
}

function mealSelect(selected: string) {
  const select = document.createElement('select');
  for (const meal of MEALS) {
    const option = document.createElement('option');
    option.value = meal.value;
    option.textContent = meal.label;
    if (meal.value === selected) option.selected = true;
    select.append(option);
  }
  return select;
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
