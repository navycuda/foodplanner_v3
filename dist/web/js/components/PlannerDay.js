import { getDayName, getIsoDate } from "../common.js";
export default class PlannerDay extends HTMLElement {
    #date;
    connectedCallback() {
        if (!this.hasChildNodes()) {
            this.render();
        }
    }
    render() {
        this.replaceChildren();
        const dayElement = document.createElement('h3');
        const isoDateElement = document.createElement('h4');
        const day = getDayName(this.#date);
        const isoDate = getIsoDate(this.#date);
        dayElement.innerText = day;
        isoDateElement.innerText = isoDate;
        this.append(dayElement, isoDateElement);
    }
    static create(date) {
        const plannerDay = document.createElement('planner-day');
        plannerDay.#date = date;
        return plannerDay;
    }
}
customElements.define('planner-day', PlannerDay);
