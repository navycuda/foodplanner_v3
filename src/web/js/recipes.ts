import type { RecipeSummary } from '../../types.js';
import { api, getElementByIdOrThrow } from './common.js';
import RecipeCard from './components/RecipeCard.js';
import { fillIngredientHost, readIngredientHost, type ItemChoice } from './recipeForm.js';
import { formatKcal, previewRecipe } from './recipeMath.js';

const list = getElementByIdOrThrow('recipe_list');
const error = getElementByIdOrThrow<HTMLParagraphElement>('recipe_error');
const addForm = getElementByIdOrThrow<HTMLFormElement>('add_recipe');
const ingredientHost = getElementByIdOrThrow('add_ingredients');
const preview = getElementByIdOrThrow('add_preview');
const addButton = getElementByIdOrThrow<HTMLButtonElement>('add_ingredient');

const openIds = new Set<number>();
let items: ItemChoice[] = [];

addButton.addEventListener('click', () => {
  const current = readDraft();
  current.push({ item_id: items[0]?.id ?? 0, quantity: null });
  fillIngredientHost(ingredientHost, items, current);
  showPreview();
});

ingredientHost.addEventListener('ingredients-changed', () => showPreview());
addForm.addEventListener('input', () => showPreview());

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    clearError();
    const button = addForm.querySelector('button[type="submit"]');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    try {
      await api('/api/recipes', 'POST', readRecipeForm(addForm));
      addForm.reset();
      fillIngredientHost(ingredientHost, items, []);
      showPreview();
      await load();
    } catch (err) {
      showError(err);
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  })();
});

list.addEventListener('recipe-open', (event) => {
  const detail = (event as CustomEvent<{ id: number; open: boolean }>).detail;
  if (detail.open) openIds.add(detail.id);
  else openIds.delete(detail.id);
});

list.addEventListener('recipe-changed', (event) => {
  const detail = (event as CustomEvent<{ id: number; reopen: boolean }>).detail;
  if (detail.reopen) openIds.add(detail.id);
  else openIds.delete(detail.id);
  void load();
});

async function load() {
  clearError();
  try {
    const [catalog, recipes] = await Promise.all([
      api<ItemChoice[]>('/api/items'),
      api<RecipeSummary[]>('/api/recipes'),
    ]);
    items = catalog;
    const empty = document.getElementById('no_items');
    if (empty) empty.hidden = items.length > 0;
    addForm.hidden = items.length === 0;
    if (ingredientHost.childElementCount === 0) fillIngredientHost(ingredientHost, items, []);
    list.replaceChildren();
    if (recipes.length === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = items.length === 0
        ? 'Add groceries first. A recipe picks from that list.'
        : 'No recipes yet. A curry and a rice are two recipes, so they can be mixed.';
      list.append(note);
    }
    for (const recipe of recipes) {
      list.append(RecipeCard.create(recipe, items, openIds.has(recipe.id)));
    }
    showPreview();
  } catch (err) {
    showError(err);
  }
}

function readDraft(): Array<{ item_id: number; quantity: number | null }> {
  return [...ingredientHost.querySelectorAll('.ingredient')].map(row => {
    const select = row.querySelector('select');
    const input = row.querySelector('input');
    const quantity = input instanceof HTMLInputElement && input.value.trim() !== '' ? Number(input.value) : null;
    return {
      item_id: select instanceof HTMLSelectElement ? Number(select.value) : 0,
      quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
    };
  });
}

function readRecipeForm(form: HTMLFormElement) {
  const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
  if (!name) throw new Error('Name is required.');
  const yieldInput = form.elements.namedItem('cooked_yield_g') as HTMLInputElement;
  const cooked = Number(yieldInput.value);
  if (!Number.isFinite(cooked) || !(cooked > 0)) throw new Error('Cooked yield must be greater than zero.');
  const notes = (form.elements.namedItem('notes') as HTMLInputElement).value.trim();
  return {
    name,
    cooked_yield_g: cooked,
    notes: notes === '' ? null : notes,
    ingredients: readIngredientHost(ingredientHost),
  };
}

function showPreview() {
  preview.replaceChildren();
  if (items.length === 0) return;
  let lines;
  try {
    lines = readIngredientHost(ingredientHost);
  } catch (err) {
    preview.textContent = err instanceof Error ? err.message : 'Add at least one ingredient.';
    return;
  }
  const yieldInput = addForm.elements.namedItem('cooked_yield_g');
  const cooked = yieldInput instanceof HTMLInputElement ? Number(yieldInput.value) : NaN;
  if (!Number.isFinite(cooked) || !(cooked > 0)) {
    preview.textContent = 'Type the cooked yield to see calories.';
    return;
  }
  const view = previewRecipe(cooked, cooked, lines.map(line => {
    const item = items.find(choice => choice.id === line.item_id);
    return {
      name: item?.name ?? 'Item',
      unit: item?.unit ?? 'g',
      quantity: line.quantity,
      gramsPerPiece: item?.grams_per_piece ?? null,
      kcalPer100g: item?.kcal_per_100g ?? 0,
      available: item?.available ?? 0,
      useSoon: item?.use_soon ?? false,
    };
  }));
  const heading = document.createElement('p');
  heading.textContent = `${formatKcal(view.batchKcal)} in this batch · ${formatKcal(view.kcalPer100g)} / 100 g cooked`;
  preview.append(heading);
  const stock = document.createElement('p');
  stock.textContent = view.canMake
    ? 'The batch as written can be made from what is in the house.'
    : 'The batch as written needs more than what is in the house.';
  if (!view.canMake) stock.className = 'negative';
  preview.append(stock);
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
