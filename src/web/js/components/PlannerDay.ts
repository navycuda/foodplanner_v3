import { getDayName, getIsoDate } from "../common.js";

export default class PlannerDay extends HTMLElement {
  #date!:Date;




  connectedCallback(){
    if (!this.hasChildNodes()) { this.render(); }
  }




  render(){
    this.replaceChildren();

    const dayElement = document.createElement('h3');
    const isoDateElement = document.createElement('h4');

    const day = getDayName(this.#date);
    const isoDate = getIsoDate(this.#date);

    dayElement.innerText = day;
    isoDateElement.innerText = isoDate;

    this.append(dayElement,isoDateElement);
  }


  static create(date:Date){
    const plannerDay = document.createElement('planner-day') as PlannerDay;
    plannerDay.#date = date;
    return plannerDay;
  }
}
customElements.define('planner-day',PlannerDay);
