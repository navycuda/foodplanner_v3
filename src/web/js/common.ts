export function getIsoDate(date: Date = new Date()) {
  // Local calendar day. toISOString() is UTC and would roll forward in the evening.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getElementByIdOrThrow<H extends HTMLElement = HTMLElement>(id: string): H {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Element ${id} not found`);
  return element as H;
}

export function getElementByClassOrThrow<
  H extends HTMLElement = HTMLElement
>(parent: HTMLElement, className: string, index: number = 0): H {
  const element = parent.getElementsByClassName(className)[index];
  if (!element) throw new Error(`Element class ${className} at i:${index} not found`);
  return element as H;
}

export function getDayName(date: Date) {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let payload: { error?: unknown } = {};
  if (text) {
    try {
      payload = JSON.parse(text) as { error?: unknown };
    } catch {
      throw new Error(`Request failed (${response.status}).`);
    }
  }
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

/** CAD with a leading minus when negative, never parentheses. */
export function formatCad(amount: number): string {
  const text = `$${Math.abs(amount).toFixed(2)}`;
  return amount < 0 ? `-${text}` : text;
}

/** Per-gram price, shown per 100 g so it stays readable. */
export function formatPer100g(perGram: number | null): string {
  if (perGram == null) return '—';
  const per100 = perGram * 100;
  const abs = Math.abs(per100);
  const digits = abs > 0 && abs < 1 ? 4 : 2;
  const text = `$${abs.toFixed(digits)} / 100 g`;
  return per100 < 0 ? `-${text}` : text;
}

export function formatQty(amount: number, unit: 'g' | 'piece' | 'package'): string {
  const negative = amount < 0;
  const rounded = Math.round(Math.abs(amount) * 10) / 10;
  const number = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  let label = 'g';
  if (unit === 'piece') label = rounded === 1 ? 'piece' : 'pieces';
  if (unit === 'package') label = rounded === 1 ? 'package' : 'packages';
  return `${negative ? '-' : ''}${number} ${label}`;
}

/** Write a figure and turn it red when the amount is negative. */
export function showFigure(node: HTMLElement, amount: number | null, text: string) {
  node.textContent = text;
  node.classList.toggle('negative', amount != null && amount < 0);
}
