import { getElementByClassOrThrow, getElementByIdOrThrow, getIsoDate } from "./common.js";
import PlannerDay from "./components/PlannerDay.js";
import './components/PlannerDay.js';


const todays_date = getIsoDate();


const week_one = getElementByIdOrThrow('week_one');
const week_one_days = getElementByClassOrThrow<HTMLDivElement>(week_one,'days');

const week_two = getElementByIdOrThrow('week_two');
const week_two_days = getElementByClassOrThrow<HTMLDivElement>(week_two,'days');


const weeks = getTwoWeeks();



for (const date of weeks.week_one){
  const plannerDate = PlannerDay.create(date);

  week_one_days.append(plannerDate);
}
for (const date of weeks.week_two){
  const plannerDate = PlannerDay.create(date);

  week_two_days.append(plannerDate);
}










function getTwoWeeks(){
  const today = new Date();

  // Find Sunday of the current week(getDay() returns 0 for sunday)
  const date = new Date(today);
  date.setDate(today.getDate() - today.getDay());


  const buildWeek = (startDate:Date) => {
    const week:Date[] = [];
    for (let i = 0; i < 7; i++){
      const day = new Date(startDate);
      day.setDate(startDate.getDate() + i);
      week.push(day);
    }
    return week;
  }

  const week_one = buildWeek(date);
  date.setDate(date.getDate() + 7);
  const week_two = buildWeek(date);

  return { week_one, week_two };
}
