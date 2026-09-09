/**
 * Thin native SVG helpers — DomHost chrome shells, not vector ink paint.
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const XLINK_NS = 'http://www.w3.org/1999/xlink';

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | null | undefined>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  if (attrs) setAttrs(el, attrs);
  return el;
}

export function setAttrs(
  el: Element,
  attrs: Record<string, string | number | null | undefined>
): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) el.removeAttribute(k);
    else el.setAttribute(k, String(v));
  }
}

export function setStyles(
  el: HTMLElement | SVGElement,
  styles: Record<string, string | null | undefined>
): void {
  for (const [k, v] of Object.entries(styles)) {
    if (v == null) el.style.removeProperty(k);
    else el.style.setProperty(k, v);
  }
}

export function append(parent: Element, child: Element): void {
  parent.appendChild(child);
}

export function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function ensureDefs(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector(':scope > defs') as SVGDefsElement | null;
  if (!defs) {
    defs = svgEl('defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

export function urlRef(id: string): string {
  return `url(#${id})`;
}

export function createSvgRoot(host: HTMLElement): SVGSVGElement {
  clearChildren(host);
  const root = svgEl('svg');
  host.appendChild(root);
  return root;
}

export function getBBox(el: SVGGraphicsElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  try {
    const b = el.getBBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  } catch {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
}
