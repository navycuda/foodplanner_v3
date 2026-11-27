import type { PlanDish, RecipeSummary } from '../../types.js';
import { api, getElementByClassOrThrow, getElementByIdOrThrow, getIsoDate } from './common.js';
import PlannerDay from './components/PlannerDay.js';
import { formatKcal } from './recipeMath.js';

const today = getIsoDate();
const weeks = getTwoWeeks();

document.addEventListener('plan-changed', () => { void load(); });
void load();

async function load() {
  const start = weeks.week_one[0];
  const end = weeks.week_two[6];
  if (!start || !end) return;
  try {
    const from = getIsoDate(start);
    const to = getIsoDate(end);
    const [recipes, dishes] = await Promise.all([
      api<RecipeSummary[]>('/api/recipes'),
      api<PlanDish[]>(`/api/plan?from=${from}&to=${to}`),
    ]);
    fillWeek('week_one', weeks.week_one, recipes, dishes);
    fillWeek('week_two', weeks.week_two, recipes, dishes);
  } catch (err) {
    const note = document.querySelector('#week_one .days');
    if (note) note.textContent = err instanceof Error ? err.message : 'Could not load the plan.';
  }
}

function fillWeek(id: string, dates: Date[], recipes: RecipeSummary[], dishes: PlanDish[]) {
  const week = getElementByIdOrThrow(id);
  const days = getElementByClassOrThrow<HTMLDivElement>(week, 'days');
  const kcal = dishes
    .filter(dish => dates.some(date => getIsoDate(date) === dish.date))
    .reduce((sum, dish) => sum + dish.kcal, 0);
  const total = week.querySelector('.week-kcal');
  if (total) total.textContent = kcal > 0 ? formatKcal(kcal) : '';
  days.replaceChildren();
  for (const date of dates) {
    const iso = getIsoDate(date);
    const entries = dishes.filter(dish => dish.date === iso);
    days.append(PlannerDay.create(date, entries, recipes, today));
  }
}

function getTwoWeeks() {
  const now = new Date();
  // Sunday of this week. getDay() is 0 for Sunday.
  const date = new Date(now);
  date.setDate(now.getDate() - now.getDay());

  const buildWeek = (startDate: Date) => {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(startDate);
      day.setDate(startDate.getDate() + i);
      week.push(day);
    }
    return week;
  };

  const weekOne = buildWeek(date);
  date.setDate(date.getDate() + 7);
  const weekTwo = buildWeek(date);
  return { week_one: weekOne, week_two: weekTwo };
}
