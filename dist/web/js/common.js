export function getIsoDate(date) {
    let result = "";
    if (!date) {
        result = new Date().toISOString().split('T')[0];
    }
    else {
        result = date.toISOString().split('T')[0];
    }
    return result;
}
export function getElementByIdOrThrow(id) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Element ${id} not found`);
    }
    return element;
}
export function getElementByClassOrThrow(parent, className, index = 0) {
    const element = parent.getElementsByClassName(className)[index];
    if (!element) {
        throw new Error(`Element class ${className} at i:${index} not found`);
    }
    return element;
}
export function getDayName(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
}
