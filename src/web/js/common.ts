export function getIsoDate(date?:Date){
  let result = "";
  if (!date){
    result = new Date().toISOString().split('T')[0]!;
  } else {
    result = date.toISOString().split('T')[0]!;
  }
  return result;
}
export function getElementByIdOrThrow<H extends HTMLElement = HTMLElement>(id:string):H{
  const element = document.getElementById(id);
  if (!element) { throw new Error(`Element ${id} not found`); }
  return element as H;
}
export function getElementByClassOrThrow<
  H extends HTMLElement = HTMLElement
>(parent:HTMLElement, className:string,index:number = 0):H{
  const element = parent.getElementsByClassName(className)[index];
  if (!element) { throw new Error(`Element class ${className} at i:${index} not found`); }
  return element as H;
}
export function getDayName(date:Date){
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}