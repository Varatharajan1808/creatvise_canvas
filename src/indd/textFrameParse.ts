/** TextFramePreference → layout box for rasterization (local frame space). */

function localName(el: Element): string {
  return el.localName || el.nodeName.split(':').pop() || '';
}

export interface IdmlTextFrameLayout {
  insetTop: number;
  insetLeft: number;
  insetBottom: number;
  insetRight: number;
  columnWidth?: number;
  verticalJustification?: string;
}

const ZERO_INSETS: IdmlTextFrameLayout = {
  insetTop: 0,
  insetLeft: 0,
  insetBottom: 0,
  insetRight: 0,
};

function findTextFramePreference(itemEl: Element): Element | null {
  const all = itemEl.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (localName(el).toLowerCase() === 'textframepreference') return el;
  }
  return null;
}

function readInsetSpacing(prefEl: Element): { top: number; left: number; bottom: number; right: number } {
  const out = { top: 0, left: 0, bottom: 0, right: 0 };
  const props = prefEl.getElementsByTagName('*');
  for (let i = 0; i < props.length; i++) {
    const el = props[i];
    if (localName(el).toLowerCase() !== 'insetspacing') continue;
    const items: number[] = [];
    for (let j = 0; j < el.childNodes.length; j++) {
      const child = el.childNodes[j];
      if (child.nodeType !== 1) continue;
      const c = child as Element;
      if (localName(c).toLowerCase() !== 'listitem') continue;
      const n = Number(c.textContent?.trim());
      items.push(Number.isFinite(n) ? n : 0);
    }
    if (items.length >= 4) {
      out.top = items[0];
      out.left = items[1];
      out.bottom = items[2];
      out.right = items[3];
    }
    break;
  }
  return out;
}

/** InDesign IDML: inset list order top, left, bottom, right. */
export function parseTextFrameLayout(itemEl: Element): IdmlTextFrameLayout {
  const pref = findTextFramePreference(itemEl);
  if (!pref) return { ...ZERO_INSETS };
  const insets = readInsetSpacing(pref);
  const colRaw = pref.getAttribute('TextColumnFixedWidth');
  const columnWidth = colRaw ? Number(colRaw) : undefined;
  const verticalJustification = pref.getAttribute('VerticalJustification') ?? undefined;
  return {
    insetTop: insets.top,
    insetLeft: insets.left,
    insetBottom: insets.bottom,
    insetRight: insets.right,
    columnWidth: Number.isFinite(columnWidth) && columnWidth! > 0 ? columnWidth : undefined,
    verticalJustification,
  };
}
