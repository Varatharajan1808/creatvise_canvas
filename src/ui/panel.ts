import { escapeHtml as esc } from '../utils';
import { type Doc, type Node, docOf, nodeBounds, walk, effVisible } from '../core/model';
import { isNodeSelected, selectionAffectedDocs, selectionBounds, selectionSpansDocuments, type Selection } from '../canvas/selection';
import {
  getTextInfo,
  getShapeColor,
  getShapeBorderInfo,
  getBrightnessContrastInfo,
  shapeColorBlockReason,
  shapeBorderBlockReason,
  nodeSupportsVectorFillEdit,
  canEditShapeColorOnNode,
  rgbToHex,
} from '../operations/edit';
import {
  aiPlacedImageReplaceBlockedReason,
  canDeleteLayer,
  canDuplicateLayer,
  canEditAiTextOnNode,
  canReplaceAiImageOnNode,
  canReplaceIdmlImageOnNode,
  canReorderLayerStackStep,
  capabilitiesForDoc,
  opacityExportsToFile,
} from '../formats/formatCaps';
import { canDuplicateAiLayer } from '../ai/aiLayerMeta';
import { getAiTextPreviewNote } from '../ai/aiTextEdit';

export interface PanelState {
  docs: Doc[];
  selection: Selection;
}

export interface PanelHandlers {
  select(n: Node | null, shiftKey?: boolean): void;
  toggleVisible(n: Node): void;
  toggleLocked(n: Node): void;
  rename(n: Node): void;
  renameDoc?(d: Doc): void;
  remove(n: Node): void;
  closeDoc(d: Doc): void;
  setOpacityPreview(n: Node, v: number): void;
  commitOpacity(n: Node, from: number, to: number): void;
  editPosition(n: Node, x: string, y: string, commit: boolean): void;
  setTransform(n: Node, t: { w?: number; h?: number; rotation?: number }, commit?: boolean): void;
  editText(n: Node, patch: {
    text?: string;
    fontSize?: number;
    color?: string;
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
  }, commit: boolean): void;
  editShapeColor(n: Node, hex: string, commit: boolean): void;
  editShapeBorder(n: Node, patch: { enabled?: boolean; width?: number; color?: string }, commit: boolean): void;
  editBrightnessContrast(n: Node, patch: { brightness?: number; contrast?: number; useLegacy?: boolean }, commit: boolean): void;
  replaceImage?(n: Node, file: File): void;
  duplicate?(n: Node): void;
  toggleGroupExpanded?(n: Node): void;
  /** Move layer toward front of stack (higher z-index / up in panel). */
  reorderStackUp?(n: Node): void;
  /** Move layer toward back of stack (lower z-index / down in panel). */
  reorderStackDown?(n: Node): void;
  showUnsupportedDoc?(doc: Doc): void;
  showUnsupportedNode?(n: Node): void;
}

const ICON = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.7 8.4 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  stackUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>',
  stackDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  // Layer kind SVGs
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  raster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 7 4 4 20 4 20 7"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  shape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>',
};

/** Whether nested rows are shown under a group folder in the layer panel. */
export function panelShowsGroupChildren(n: Node): boolean {
  if (!n.children.length) return false;
  if (n.kind !== 'group') return true;
  return n.src.opened !== false;
}

export function toggleGroupRowExpanded(n: Node): void {
  if (n.kind !== 'group') return;
  const open = n.src.opened !== false;
  n.src.opened = !open;
}

function rows(
  nodes: Node[],
  depth: number,
  state: PanelState,
  out: string[],
  ids: Map<string, Node>,
  doc: Doc,
) {
  const allowDup = canDuplicateLayer(doc);
  const allowDel = canDeleteLayer(doc);
  // PSD order is bottom -> top; the panel shows top first
  for (const n of [...nodes].reverse()) {
    ids.set(n.id, n);
    const stackIdx = nodes.indexOf(n);
    const dim = !effVisible(n) ? ' dim' : '';
    const sel = isNodeSelected(state.selection, n) ? ' sel' : '';
    const dupBtn = allowDup && (doc.format !== 'ai' || canDuplicateAiLayer(doc, n))
      ? `<button class="ibtn" data-act="dup" aria-label="Duplicate layer" title="Duplicate layer (Ctrl+D)">${ICON.copy}</button>`
      : '';
    const delBtn = allowDel
      ? `<button class="ibtn del" data-act="del" aria-label="Delete layer" title="Delete layer">${ICON.trash}</button>`
      : '';
    const canUp =
      stackIdx < nodes.length - 1 &&
      canReorderLayerStackStep(doc, n, nodes, stackIdx, stackIdx + 1);
    const canDown =
      stackIdx > 0 && canReorderLayerStackStep(doc, n, nodes, stackIdx, stackIdx - 1);
    const upBtn = canUp
      ? `<button class="ibtn" data-act="stack-up" aria-label="Move layer up" title="Move layer up (toward front)">${ICON.stackUp}</button>`
      : '';
    const downBtn = canDown
      ? `<button class="ibtn" data-act="stack-down" aria-label="Move layer down" title="Move layer down (toward back)">${ICON.stackDown}</button>`
      : '';
    const isGroup = n.kind === 'group' && n.children.length > 0;
    const expanded = panelShowsGroupChildren(n);
    const expandBtn = isGroup
      ? `<button type="button" class="ibtn group-expand" data-act="toggle-expand" aria-label="${expanded ? 'Collapse group' : 'Expand group'}" title="${expanded ? 'Collapse group' : 'Expand group'}">${expanded ? '▾' : '▸'}</button>`
      : `<span class="group-expand-spacer" aria-hidden="true"></span>`;
    out.push(
      `<div class="row${sel}${dim}" data-id="${n.id}" style="padding-left:${12 + depth * 16}px">
        ${expandBtn}
        <span class="kind-icon kind-${n.kind}" title="Layer type: ${n.kind}">${ICON[n.kind]}</span>
        <span class="name" title="${esc(n.name)} (Double click to rename)">${esc(n.name)}</span>
        ${n.unsupported.length ? `<button class="warn-tag-btn" data-unsupported-node="${n.id}" title="Click to view unsupported features in popup">!</button>` : ''}
        <div class="row-actions">
          ${upBtn}
          ${downBtn}
          ${dupBtn}
          <button class="ibtn" data-act="rename" aria-label="Rename layer" title="Rename layer">${ICON.edit}</button>
          <button class="ibtn" data-act="vis" aria-label="Toggle visibility" title="${n.visible ? 'Hide' : 'Show'} layer">${n.visible ? ICON.eye : ICON.eyeOff}</button>
          <button class="ibtn" data-act="lock" aria-label="Toggle lock" title="${n.locked ? 'Unlock' : 'Lock'} layer">${n.locked ? ICON.lock : ICON.unlock}</button>
          ${delBtn}
        </div>
      </div>`,
    );
    if (panelShowsGroupChildren(n)) rows(n.children, depth + 1, state, out, ids, doc);
  }
}

export function renderLayers(el: HTMLElement, state: PanelState, h: PanelHandlers) {
  const ids = new Map<string, Node>();
  const docById = new Map<string, Doc>();
  const out: string[] = [];

  const totalLayers = state.docs.reduce((sum, d) => sum + [...walk(d.roots)].length, 0);

  out.push(`
    <div class="panel-section-header">
      <div class="panel-title-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="panel-title-icon"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        <span class="panel-title-text">LAYERS</span>
      </div>
      <span class="badge-count">${totalLayers}</span>
    </div>
  `);

  for (const d of state.docs) {
    docById.set(d.id, d);
    const count = [...walk(d.roots)].filter((n) => n.unsupported.length).length;
    out.push(
      `<div class="doc-head" data-doc-id="${d.id}">
        <div class="doc-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <span class="doc-title" data-renamedoc="${d.id}" title="${esc(d.name)} (Click or double-click to rename file)">${esc(d.name)}</span>
        <button class="ibtn doc-rename-btn" data-renamedoc="${d.id}" aria-label="Rename file" title="Rename file">${ICON.edit}</button>
        <span class="fmt">${d.format.toUpperCase()}</span>
        ${count ? `<button class="warn-tag warn-tag-interactive" data-unsupported-doc="${d.id}" title="Click to view unsupported features">${count} unsupported</button>` : ''}
        <button class="ibtn doc-close-btn" data-closedoc="${d.id}" aria-label="Close file" title="Close file">${ICON.close}</button>
      </div>`,
    );
    rows(d.roots, 0, state, out, ids, d);
  }

  el.innerHTML = out.join('') || `
    <div class="panel-section-header">
      <div class="panel-title-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="panel-title-icon"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        <span class="panel-title-text">LAYERS</span>
      </div>
      <span class="badge-count">0</span>
    </div>
    <div class="empty-panel-note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M3 9h18"/></svg>
      <p>No files open</p>
      <span>Open a .psd or .ai file to view layers</span>
    </div>
  `;

  el.onclick = (e) => {
    const t = e.target as HTMLElement;

    // Handle doc rename clicks
    const renameDocId = (t.closest('[data-renamedoc]') as HTMLElement | null)?.dataset.renamedoc;
    if (renameDocId) {
      const doc = docById.get(renameDocId);
      if (doc && h.renameDoc) {
        h.renameDoc(doc);
        return;
      }
    }

    // Handle unsupported warning popup clicks
    const unsupDocId = (t.closest('[data-unsupported-doc]') as HTMLElement | null)?.dataset.unsupportedDoc;
    if (unsupDocId) {
      const doc = docById.get(unsupDocId);
      if (doc && h.showUnsupportedDoc) {
        h.showUnsupportedDoc(doc);
        return;
      }
    }

    const unsupNodeId = (t.closest('[data-unsupported-node]') as HTMLElement | null)?.dataset.unsupportedNode;
    if (unsupNodeId) {
      const node = ids.get(unsupNodeId);
      if (node && h.showUnsupportedNode) {
        h.showUnsupportedNode(node);
        return;
      }
    }

    const closeId = (t.closest('[data-closedoc]') as HTMLElement | null)?.dataset.closedoc;
    if (closeId) {
      h.closeDoc(docById.get(closeId)!);
      return;
    }

    const row = t.closest('.row') as HTMLElement | null;
    if (!row) return;
    const node = ids.get(row.dataset.id!)!;
    const act = (t.closest('[data-act]') as HTMLElement | null)?.dataset.act;
    if (act === 'toggle-expand') {
      h.toggleGroupExpanded?.(node);
      return;
    }
    if (act === 'vis') h.toggleVisible(node);
    else if (act === 'lock') h.toggleLocked(node);
    else if (act === 'del') h.remove(node);
    else if (act === 'rename') h.rename(node);
    else if (act === 'dup') h.duplicate?.(node);
    else if (act === 'stack-up') h.reorderStackUp?.(node);
    else if (act === 'stack-down') h.reorderStackDown?.(node);
    else h.select(node, e.shiftKey);
  };

  el.ondblclick = (e) => {
    const t = e.target as HTMLElement;
    const docHead = t.closest('.doc-head') as HTMLElement | null;
    if (docHead && docHead.dataset.docId) {
      const doc = docById.get(docHead.dataset.docId);
      if (doc && h.renameDoc) {
        h.renameDoc(doc);
        return;
      }
    }
    const row = t.closest('.row') as HTMLElement | null;
    if (row) h.rename(ids.get(row.dataset.id!)!);
  };
}

const FONT_OPTIONS = [
  'Inter',
  'Plus Jakarta Sans',
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Georgia',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
  'Impact',
  'Comic Sans MS',
];

function contentSection(n: Node, doc: Doc | null): string {
  const caps = doc ? capabilitiesForDoc(doc) : null;

  if (n.src.adjustment) {
    if (n.src.adjustment.type === 'brightness/contrast') {
      const info = getBrightnessContrastInfo(n) ?? { brightness: 0, contrast: 0, useLegacy: false };
      return `<div class="card-section">
        <div class="card-title">Brightness / Contrast</div>
        <div class="field-col">
          <div class="field-between">
            <label>Brightness</label>
            <span id="p-bc-brightness-val" class="badge-value">${info.brightness}</span>
          </div>
          <div class="range-num-wrap">
            <input type="range" id="p-bc-brightness" min="-150" max="150" step="1" value="${info.brightness}" class="slider-accent">
            <input type="number" id="p-bc-brightness-num" min="-150" max="150" step="1" value="${info.brightness}" class="num-input-compact">
          </div>
        </div>
        <div class="field-col" style="margin-top:10px;">
          <div class="field-between">
            <label>Contrast</label>
            <span id="p-bc-contrast-val" class="badge-value">${info.contrast}</span>
          </div>
          <div class="range-num-wrap">
            <input type="range" id="p-bc-contrast" min="-50" max="100" step="1" value="${info.contrast}" class="slider-accent">
            <input type="number" id="p-bc-contrast-num" min="-50" max="100" step="1" value="${info.contrast}" class="num-input-compact">
          </div>
        </div>
        <div class="field-col" style="margin-top:10px;">
          <label class="checkbox-label">
            <input type="checkbox" id="p-bc-legacy" ${info.useLegacy ? 'checked' : ''}>
            <span>Use Legacy</span>
          </label>
        </div>
      </div>`;
    }
    return `<div class="card-section">
      <div class="card-title">Adjustment Layer</div>
      <div class="note-box">
        <strong>${esc(n.src.adjustment.type.toUpperCase())}</strong>: Simulated in preview and preserved on export. Direct parameter editing for this adjustment type is coming soon.
      </div>
    </div>`;
  }

  const t = getTextInfo(n);
  const aiLiveText = doc ? canEditAiTextOnNode(doc, n) : false;
  if (t) {
    if (caps && !caps.editText && !aiLiveText) {
      return `<div class="card-section"><div class="card-title">Text Content</div><div class="note-box">Text editing is not available for .ai files in the browser.</div></div>`;
    }
    if (t.reason && !aiLiveText) {
      return `<div class="card-section"><div class="card-title">Text Content</div><div class="note-box warn">${esc(t.reason)}</div></div>`;
    }

    const aiNote = aiLiveText ? getAiTextPreviewNote(n) : null;
    const aiNoteHtml = aiNote
      ? `<div class="note-box" style="margin-bottom:10px;">${esc(aiNote)}</div>${t.reason ? `<div class="note-box warn" style="margin-bottom:10px;">${esc(t.reason)}</div>` : ''}`
      : t.reason
        ? `<div class="note-box warn" style="margin-bottom:10px;">${esc(t.reason)}</div>`
        : '';

    const fontOpts = [...FONT_OPTIONS];
    const cleanFont = t.fontFamily.replace(/(MT|PS)$/i, '').split('-')[0].trim();
    if (!fontOpts.some((f) => f.toLowerCase() === cleanFont.toLowerCase() || f.toLowerCase() === t.fontFamily.toLowerCase())) {
      fontOpts.unshift(t.fontFamily);
    }

    const fontOptionsHtml = fontOpts
      .map((f) => {
        const isSel = f.toLowerCase() === t.fontFamily.toLowerCase() || f.toLowerCase() === cleanFont.toLowerCase();
        return `<option value="${esc(f)}" ${isSel ? 'selected' : ''}>${esc(f)}</option>`;
      })
      .join('');

    return `<div class="card-section">
      <div class="card-title">Text Properties</div>
      ${aiNoteHtml}
      <div class="field-col">
        <label>Content</label>
        <textarea id="p-text" rows="3" class="input-text" spellcheck="false">${esc(t.text)}</textarea>
      </div>

      <div class="field-col">
        <label>Font Family</label>
        <select id="p-ff" class="select-input">
          ${fontOptionsHtml}
        </select>
      </div>

      <div class="grid-2">
        <div class="field">
          <label>Size</label>
          <div class="input-unit-wrap">
            <input type="number" id="p-fs" min="1" step="1" value="${Math.round(t.fontSize * 10) / 10}">
            <span class="unit">pt</span>
          </div>
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-picker-wrap">
            <input type="color" id="p-tc" value="${rgbToHex(t.color)}">
            <span class="color-hex-val">${rgbToHex(t.color)}</span>
          </div>
        </div>
      </div>

      <div class="field-col" style="margin-top:4px;">
        <label>Styling & Alignment</label>
        <div class="field-between">
          <div class="btn-group">
            <button type="button" id="p-bold" class="tool-btn ${t.bold ? 'active' : ''}" title="Toggle Bold font style" aria-label="Toggle Bold">
              <b>B</b>
            </button>
            <button type="button" id="p-italic" class="tool-btn ${t.italic ? 'active' : ''}" title="Toggle Italic font style" aria-label="Toggle Italic">
              <i>I</i>
            </button>
          </div>
          <div class="btn-group">
            <button type="button" id="p-al-left" class="tool-btn ${t.alignment === 'left' ? 'active' : ''}" title="Align Left" aria-label="Align Left">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>
            </button>
            <button type="button" id="p-al-center" class="tool-btn ${t.alignment === 'center' ? 'active' : ''}" title="Align Center" aria-label="Align Center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>
            </button>
            <button type="button" id="p-al-right" class="tool-btn ${t.alignment === 'right' ? 'active' : ''}" title="Align Right" aria-label="Align Right">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }

  if (nodeSupportsVectorFillEdit(n) || (doc && canEditShapeColorOnNode(doc, n))) {
    if (doc && !canEditShapeColorOnNode(doc, n)) {
      return `<div class="card-section"><div class="card-title">Vector Shape</div><div class="note-box">Shape color editing is not available for this layer.</div></div>`;
    }
    const c = getShapeColor(n);
    const borderWhy = shapeBorderBlockReason(n);
    const border = borderWhy ? null : getShapeBorderInfo(n);
    const why = shapeColorBlockReason(n);
    if (why) return `<div class="card-section"><div class="card-title">Vector Shape</div><div class="note-box warn">${esc(why)}</div></div>`;

    const fillRgb = c ?? { r: 180, g: 180, b: 180 };
    const fillHtml = fillRgb
      ? `<div class="card-section">
          <div class="card-title">Vector Shape Fill</div>
          ${!c ? `<div class="note-box">No fill on import — pick a color to add one.</div>` : ''}
          <div class="field">
            <label>Fill</label>
            <div class="color-picker-wrap">
              <input type="color" id="p-sc" value="${rgbToHex(fillRgb)}">
              <span class="color-hex-val">${rgbToHex(fillRgb)}</span>
            </div>
          </div>
        </div>`
      : '';

    const borderHtml = borderWhy
      ? `<div class="card-section"><div class="card-title">Shape Border (Outline)</div><div class="note-box warn">${esc(borderWhy)}</div></div>`
      : border
      ? `<div class="card-section">
          <div class="card-title">Shape Border (Outline)</div>
          <div class="field" style="margin-bottom:10px;">
            <label class="checkbox-field" style="width:auto;">
              <input type="checkbox" id="p-sb-en" ${border.enabled ? 'checked' : ''}>
              <span>Enable Border</span>
            </label>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>Width</label>
              <div class="input-unit-wrap">
                <input type="number" id="p-sb-w" min="1" max="100" value="${border.width}" ${!border.enabled ? 'disabled' : ''}>
                <span class="unit">px</span>
              </div>
            </div>
            <div class="field">
              <label>Color</label>
              <div class="color-picker-wrap">
                <input type="color" id="p-sb-c" value="${rgbToHex(border.color)}" ${!border.enabled ? 'disabled' : ''}>
                <span class="color-hex-val">${rgbToHex(border.color)}</span>
              </div>
            </div>
          </div>
        </div>`
      : '';

    return `${fillHtml}${borderHtml}`;
  }

  if (n.kind === 'raster') {
    const aiReplace = doc ? canReplaceAiImageOnNode(doc, n) : false;
    const idmlReplace = doc ? canReplaceIdmlImageOnNode(doc, n) : false;
    const psdReplace = caps?.replaceImage ?? false;
    if (!psdReplace && !aiReplace && !idmlReplace) {
      const reason =
        doc?.format === 'ai'
          ? aiPlacedImageReplaceBlockedReason(doc, n)
          : 'Replace image is not available for this layer.';
      return `<div class="card-section"><div class="card-title">Image Asset</div><div class="note-box">${esc(reason)}</div></div>`;
    }
    const aiNote = aiReplace
      ? `<div class="note-box">Replaces the embedded PDF image in this layer (DeviceRGB FlateDecode). Placement, opacity, and transforms in the file are preserved on export.</div>`
      : idmlReplace
        ? `<div class="note-box">Replaces the linked file in the IDML package (Links/). Frame transform and link URI are preserved; image is exported as PNG.</div>`
        : '';
    return `
      <div class="card-section">
        <div class="card-title">Image Asset</div>
        ${aiNote}
        <button type="button" id="p-img-replace" class="btn-action full-width" title="Replace image with another file from your computer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Replace Image...
        </button>
        <input type="file" id="p-file-replace" accept="image/*" style="display:none">
      </div>
    `;
  }

  return '';
}

// Track previous selected node to allow in-place updates without destroying DOM focus!
let lastPropsNodeId: string | null = null;
let lastPropsKind: string | null = null;

export function renderProps(el: HTMLElement, state: PanelState, h: PanelHandlers) {
  const { selection } = state;
  const n = selection.primary;
  const multi = selection.nodes.length > 1;
  const docWarnings = state.docs.flatMap((d) => d.warnings.map((w) => `${d.name}: ${w}`));
  const warn = docWarnings.length
    ? `<div class="card-section"><div class="card-title">File Warnings</div><ul class="unsup-list">${docWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';

  if (!n) {
    lastPropsNodeId = null;
    lastPropsKind = null;
    el.innerHTML = `
      <div class="panel-section-header">
        <div class="panel-title-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="panel-title-icon"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="4"/></svg>
          <span class="panel-title-text">PROPERTIES</span>
        </div>
      </div>
      <div class="empty-panel-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
        <p>No Layer Selected</p>
        <span>Click any layer on the canvas or in the layer list to inspect and edit its properties.</span>
      </div>
      ${warn}
    `;
    return;
  }

  if (multi) {
    lastPropsNodeId = null;
    lastPropsKind = null;
    const doc = docOf(n, state.docs);
    const spans = selectionSpansDocuments(selection, state.docs);
    const b = spans ? null : selectionBounds(selection);
    el.innerHTML = `
      <div class="panel-section-header">
        <div class="panel-title-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="panel-title-icon"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="4"/></svg>
          <span class="panel-title-text">PROPERTIES</span>
        </div>
      </div>
      <div class="card-section">
        <div class="card-title">Multiple Selection</div>
        <p class="summary-name" style="font-weight:600;margin:0 0 8px;">${selection.nodes.length} layers selected</p>
        <p class="note-box">Shift-click layers on the canvas or in the list to add or remove from the selection, including layers from other open files. Drag on the canvas to move all selected layers together.</p>
        ${selectionSpansDocuments(selection, state.docs) ? `<p class="note-box" style="margin-top:8px;">Selection spans ${selectionAffectedDocs(selection, state.docs).length} documents. Export each file separately to save changes.</p>` : ''}
        <p class="note-box" style="margin-top:8px;">Per-layer properties, text editing, image replacement, delete, and duplicate require a single selection.</p>
      </div>
      <div class="card-section">
        <div class="card-title">Combined Bounds</div>
        ${spans
          ? `<p class="note-box" style="margin:0;">Selection spans multiple documents; the canvas overlay shows the screen-space union.</p>`
          : `<div class="grid-2 dim-fields">
          <label>X<input id="p-x" type="text" value="${b ? Math.round(b.x) : '—'}" disabled /></label>
          <label>Y<input id="p-y" type="text" value="${b ? Math.round(b.y) : '—'}" disabled /></label>
          <label>W<input id="p-w" type="text" value="${b ? Math.round(b.w) : '—'}" disabled /></label>
          <label>H<input id="p-h" type="text" value="${b ? Math.round(b.h) : '—'}" disabled /></label>
        </div>`}
      </div>
      ${spans
        ? `<div class="card-section"><div class="card-title">Documents</div><p style="margin:0;font-size:13px;color:var(--muted);">${selectionAffectedDocs(selection, state.docs).map((d) => esc(d.name)).join(', ')}</p></div>`
        : doc ? `<div class="card-section"><div class="card-title">Document</div><p style="margin:0;font-size:13px;color:var(--muted);">${esc(doc.name)}</p></div>` : ''}
      ${warn}
    `;
    return;
  }

  const doc = docOf(n, state.docs);
  const b = nodeBounds(n);
  const op = Math.round(n.opacity * 100);
  const opacityExportHint =
    doc && !opacityExportsToFile(doc)
      ? `<p class="note-box" style="margin-top:8px;font-size:12px;">Opacity affects the canvas and saved session only; it is not written into exported .ai files for this document.</p>`
      : doc?.format === 'ai' && opacityExportsToFile(doc)
        ? `<p class="note-box" style="margin-top:8px;font-size:12px;">Opacity is saved into the PDF on export and restored when you re-open the file.</p>`
        : '';

  // In-place DOM update when the same layer is selected: PRESERVES INPUT FOCUS!
  if (lastPropsNodeId === n.id && lastPropsKind === n.kind) {
    const activeEl = document.activeElement as HTMLElement | null;
    const activeId = activeEl?.id;

    const sumName = el.querySelector('.summary-name');
    if (sumName && sumName.textContent !== n.name) sumName.textContent = n.name;

    const px = el.querySelector('#p-x') as HTMLInputElement | null;
    const py = el.querySelector('#p-y') as HTMLInputElement | null;
    const pw = el.querySelector('#p-w') as HTMLInputElement | null;
    const ph = el.querySelector('#p-h') as HTMLInputElement | null;
    const pr = el.querySelector('#p-rot') as HTMLInputElement | null;
    const slider = el.querySelector('#p-op') as HTMLInputElement | null;
    const opv = el.querySelector('#p-op-v') as HTMLElement | null;

    if (b) {
      if (px && activeId !== 'p-x') px.value = String(Math.round(b.x));
      if (py && activeId !== 'p-y') py.value = String(Math.round(b.y));
      if (pw && activeId !== 'p-w') pw.value = String(Math.round(b.w));
      if (ph && activeId !== 'p-h') ph.value = String(Math.round(b.h));
    }
    if (pr && activeId !== 'p-rot') pr.value = String(n.rotation);
    if (slider && activeId !== 'p-op') slider.value = String(op);
    if (opv) opv.textContent = `${op}%`;

    if (n.kind === 'text' || (doc && canEditAiTextOnNode(doc, n))) {
      const t = getTextInfo(n);
      if (t && (!t.reason || (doc && canEditAiTextOnNode(doc, n)))) {
        const ptext = el.querySelector('#p-text') as HTMLTextAreaElement | null;
        const pfs = el.querySelector('#p-fs') as HTMLInputElement | null;
        const ptc = el.querySelector('#p-tc') as HTMLInputElement | null;
        const pff = el.querySelector('#p-ff') as HTMLSelectElement | null;
        const pbold = el.querySelector('#p-bold') as HTMLElement | null;
        const pitalic = el.querySelector('#p-italic') as HTMLElement | null;

        if (ptext && activeId !== 'p-text') ptext.value = t.text;
        if (pfs && activeId !== 'p-fs') pfs.value = String(Math.round(t.fontSize * 10) / 10);
        if (ptc && activeId !== 'p-tc') {
          const hex = rgbToHex(t.color);
          ptc.value = hex;
          const hexSpan = ptc.parentElement?.querySelector('.color-hex-val');
          if (hexSpan) hexSpan.textContent = hex;
        }
        if (pff && activeId !== 'p-ff') pff.value = t.fontFamily;
        if (pbold) pbold.classList.toggle('active', t.bold);
        if (pitalic) pitalic.classList.toggle('active', t.italic);
        ['left', 'center', 'right'].forEach((align) => {
          const btn = el.querySelector(`#p-al-${align}`);
          if (btn) btn.classList.toggle('active', t.alignment === align);
        });
      }
    }

    if (nodeSupportsVectorFillEdit(n) || (doc && canEditShapeColorOnNode(doc, n))) {
      const sc = getShapeColor(n);
      const psc = el.querySelector('#p-sc') as HTMLInputElement | null;
      const fillForPicker = sc ?? { r: 180, g: 180, b: 180 };
      if (psc && fillForPicker && activeId !== 'p-sc') {
        const hex = rgbToHex(fillForPicker);
        psc.value = hex;
        const hexSpan = psc.parentElement?.querySelector('.color-hex-val');
        if (hexSpan) hexSpan.textContent = hex;
      }

      const sb = getShapeBorderInfo(n);
      if (sb) {
        const psben = el.querySelector('#p-sb-en') as HTMLInputElement | null;
        const psbw = el.querySelector('#p-sb-w') as HTMLInputElement | null;
        const psbc = el.querySelector('#p-sb-c') as HTMLInputElement | null;
        if (psben && activeId !== 'p-sb-en') psben.checked = sb.enabled;
        if (psbw && activeId !== 'p-sb-w') {
          psbw.value = String(sb.width);
          psbw.disabled = !sb.enabled;
        }
        if (psbc && activeId !== 'p-sb-c') {
          const hex = rgbToHex(sb.color);
          psbc.value = hex;
          psbc.disabled = !sb.enabled;
          const hexSpan = psbc.parentElement?.querySelector('.color-hex-val');
          if (hexSpan) hexSpan.textContent = hex;
        }
      }
    }

    if (n.src.adjustment?.type === 'brightness/contrast') {
      const info = getBrightnessContrastInfo(n);
      if (info) {
        const bRange = el.querySelector('#p-bc-brightness') as HTMLInputElement | null;
        const bNum = el.querySelector('#p-bc-brightness-num') as HTMLInputElement | null;
        const bSpan = el.querySelector('#p-bc-brightness-val');
        const cRange = el.querySelector('#p-bc-contrast') as HTMLInputElement | null;
        const cNum = el.querySelector('#p-bc-contrast-num') as HTMLInputElement | null;
        const cSpan = el.querySelector('#p-bc-contrast-val');
        const legCb = el.querySelector('#p-bc-legacy') as HTMLInputElement | null;

        if (bRange && activeId !== 'p-bc-brightness') bRange.value = String(info.brightness);
        if (bNum && activeId !== 'p-bc-brightness-num') bNum.value = String(info.brightness);
        if (bSpan) bSpan.textContent = String(info.brightness);
        if (cRange && activeId !== 'p-bc-contrast') cRange.value = String(info.contrast);
        if (cNum && activeId !== 'p-bc-contrast-num') cNum.value = String(info.contrast);
        if (cSpan) cSpan.textContent = String(info.contrast);
        if (legCb && activeId !== 'p-bc-legacy') legCb.checked = info.useLegacy;
      }
    }

    return; // DOM was preserved in-place, zero focus loss!
  }

  // Layer changed or first render: full render with focus restoration fallback
  const prevActiveId = document.activeElement instanceof HTMLElement ? document.activeElement.id : null;
  lastPropsNodeId = n.id;
  lastPropsKind = n.kind;

  el.innerHTML = `
    <div class="panel-section-header">
      <div class="panel-title-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="panel-title-icon"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="4"/></svg>
        <span class="panel-title-text">PROPERTIES</span>
      </div>
    </div>

    <div class="card-section layer-summary-card">
      <div class="summary-head">
        <span class="kind-icon kind-${n.kind}">${ICON[n.kind]}</span>
        <div class="summary-info">
          <div class="summary-name" title="${esc(n.name)}">${esc(n.name)}</div>
          <span class="fmt kind-badge">${n.kind.toUpperCase()}</span>
        </div>
      </div>
    </div>

    <div class="card-section">
      <div class="card-title">Transform & Position</div>
      <div class="grid-2">
        <div class="field">
          <label>X</label>
          <div class="input-unit-wrap"><input type="number" id="p-x" value="${b ? Math.round(b.x) : 0}"><span class="unit">px</span></div>
        </div>
        <div class="field">
          <label>Y</label>
          <div class="input-unit-wrap"><input type="number" id="p-y" value="${b ? Math.round(b.y) : 0}"><span class="unit">px</span></div>
        </div>
      </div>

      ${n.kind === 'raster'
      ? `<div class="grid-2">
              <div class="field">
                <label>W</label>
                <div class="input-unit-wrap"><input type="number" id="p-w" min="1" value="${b ? Math.round(b.w) : 0}"><span class="unit">px</span></div>
              </div>
              <div class="field">
                <label>H</label>
                <div class="input-unit-wrap"><input type="number" id="p-h" min="1" value="${b ? Math.round(b.h) : 0}"><span class="unit">px</span></div>
              </div>
            </div>
            <div class="field">
              <label>Rotation</label>
              <div class="input-unit-wrap"><input type="number" id="p-rot" step="1" value="${n.rotation}"><span class="unit">°</span></div>
            </div>`
      : `<div class="field">
              <label>Size</label>
              <div class="size-pill">${b ? Math.round(b.w) : 0} × ${b ? Math.round(b.h) : 0} px</div>
            </div>`
    }

      <div class="field-col" style="margin-top:10px;">
        <div class="field-between">
          <label>Opacity</label>
          <span id="p-op-v" class="badge-value">${op}%</span>
        </div>
        <input type="range" id="p-op" min="0" max="100" step="1" value="${op}" class="slider-accent">
        ${opacityExportHint}
      </div>
    </div>

    ${contentSection(n, doc)}

    ${n.unsupported.length
      ? `<div class="card-section warn-section">
            <div class="card-title warn-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mini-warn-icon"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Unsupported Features
            </div>
            <ul class="unsup-list">${n.unsupported.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
          </div>`
      : ''
    }

    ${n.kind === 'shape' ? '<div class="card-section"><div class="note-box">Vector shape paths are preserved as-is. Direct path point editing is currently read-only.</div></div>' : ''}

    ${warn}
  `;

  const px = el.querySelector('#p-x') as HTMLInputElement | null;
  const py = el.querySelector('#p-y') as HTMLInputElement | null;
  const syncPos = (commit: boolean) => {
    if (px && py) h.editPosition(n, px.value, py.value, commit);
  };
  if (px) {
    px.oninput = () => syncPos(false);
    px.onchange = () => syncPos(true);
    px.onkeydown = (e) => {
      if (e.key === 'Enter') { syncPos(true); px.blur(); }
    };
  }
  if (py) {
    py.oninput = () => syncPos(false);
    py.onchange = () => syncPos(true);
    py.onkeydown = (e) => {
      if (e.key === 'Enter') { syncPos(true); py.blur(); }
    };
  }

  const pw = el.querySelector('#p-w') as HTMLInputElement | null;
  const ph = el.querySelector('#p-h') as HTMLInputElement | null;
  const pr = el.querySelector('#p-rot') as HTMLInputElement | null;
  if (pw) {
    pw.oninput = () => h.setTransform(n, { w: Number(pw.value) }, false);
    pw.onchange = () => h.setTransform(n, { w: Number(pw.value) }, true);
    pw.onkeydown = (e) => { if (e.key === 'Enter') pw.dispatchEvent(new Event('change')); };
  }
  if (ph) {
    ph.oninput = () => h.setTransform(n, { h: Number(ph.value) }, false);
    ph.onchange = () => h.setTransform(n, { h: Number(ph.value) }, true);
    ph.onkeydown = (e) => { if (e.key === 'Enter') ph.dispatchEvent(new Event('change')); };
  }
  if (pr) {
    pr.oninput = () => h.setTransform(n, { rotation: Number(pr.value) }, false);
    pr.onchange = () => h.setTransform(n, { rotation: Number(pr.value) }, true);
    pr.onkeydown = (e) => { if (e.key === 'Enter') pr.dispatchEvent(new Event('change')); };
  }

  const ptext = el.querySelector('#p-text') as HTMLTextAreaElement | null;
  const pfs = el.querySelector('#p-fs') as HTMLInputElement | null;
  const ptc = el.querySelector('#p-tc') as HTMLInputElement | null;
  const pff = el.querySelector('#p-ff') as HTMLSelectElement | null;
  const pbold = el.querySelector('#p-bold') as HTMLButtonElement | null;
  const pitalic = el.querySelector('#p-italic') as HTMLButtonElement | null;
  const palLeft = el.querySelector('#p-al-left') as HTMLButtonElement | null;
  const palCenter = el.querySelector('#p-al-center') as HTMLButtonElement | null;
  const palRight = el.querySelector('#p-al-right') as HTMLButtonElement | null;

  if (ptext) {
    ptext.oninput = () => h.editText(n, { text: ptext.value }, false);
    ptext.onchange = () => h.editText(n, { text: ptext.value }, true);
  }
  if (pfs) {
    pfs.onchange = () => h.editText(n, { fontSize: Math.max(1, Number(pfs.value) || 1) }, true);
    pfs.onkeydown = (e) => { if (e.key === 'Enter') pfs.dispatchEvent(new Event('change')); };
  }
  if (pff) {
    pff.onchange = () => h.editText(n, { fontFamily: pff.value }, true);
  }
  if (pbold) {
    pbold.onclick = () => {
      const curr = getTextInfo(n);
      if (curr) h.editText(n, { bold: !curr.bold }, true);
    };
  }
  if (pitalic) {
    pitalic.onclick = () => {
      const curr = getTextInfo(n);
      if (curr) h.editText(n, { italic: !curr.italic }, true);
    };
  }
  if (palLeft) {
    palLeft.onclick = () => h.editText(n, { alignment: 'left' }, true);
  }
  if (palCenter) {
    palCenter.onclick = () => h.editText(n, { alignment: 'center' }, true);
  }
  if (palRight) {
    palRight.onclick = () => h.editText(n, { alignment: 'right' }, true);
  }

  if (ptc) {
    ptc.oninput = () => {
      const hexSpan = el.querySelector('.color-hex-val');
      if (hexSpan) hexSpan.textContent = ptc.value;
      h.editText(n, { color: ptc.value }, false);
    };
    ptc.onchange = () => h.editText(n, { color: ptc.value }, true);
  }

  const psc = el.querySelector('#p-sc') as HTMLInputElement | null;
  if (psc) {
    psc.oninput = () => {
      const hexSpan = psc.parentElement?.querySelector('.color-hex-val');
      if (hexSpan) hexSpan.textContent = psc.value;
      h.editShapeColor(n, psc.value, false);
    };
    psc.onchange = () => h.editShapeColor(n, psc.value, true);
  }

  const psben = el.querySelector('#p-sb-en') as HTMLInputElement | null;
  const psbw = el.querySelector('#p-sb-w') as HTMLInputElement | null;
  const psbc = el.querySelector('#p-sb-c') as HTMLInputElement | null;

  if (psben) {
    psben.onchange = () => {
      if (psbw) psbw.disabled = !psben.checked;
      if (psbc) psbc.disabled = !psben.checked;
      h.editShapeBorder(n, { enabled: psben.checked }, true);
    };
  }
  if (psbw) {
    psbw.onchange = () => h.editShapeBorder(n, { width: Math.max(1, Number(psbw.value) || 1) }, true);
    psbw.onkeydown = (e) => { if (e.key === 'Enter') psbw.dispatchEvent(new Event('change')); };
  }
  if (psbc) {
    psbc.oninput = () => {
      const hexSpan = psbc.parentElement?.querySelector('.color-hex-val');
      if (hexSpan) hexSpan.textContent = psbc.value;
      h.editShapeBorder(n, { color: psbc.value }, false);
    };
    psbc.onchange = () => h.editShapeBorder(n, { color: psbc.value }, true);
  }

  const imgReplaceBtn = el.querySelector('#p-img-replace') as HTMLButtonElement | null;
  const fileReplaceInput = el.querySelector('#p-file-replace') as HTMLInputElement | null;
  if (imgReplaceBtn && fileReplaceInput) {
    imgReplaceBtn.onclick = () => fileReplaceInput.click();
    fileReplaceInput.onchange = () => {
      const file = fileReplaceInput.files?.[0];
      if (file && h.replaceImage) {
        h.replaceImage(n, file);
      }
      fileReplaceInput.value = '';
    };
  }

  const pbcB = el.querySelector('#p-bc-brightness') as HTMLInputElement | null;
  const pbcBNum = el.querySelector('#p-bc-brightness-num') as HTMLInputElement | null;
  const pbcBVal = el.querySelector('#p-bc-brightness-val');
  const pbcC = el.querySelector('#p-bc-contrast') as HTMLInputElement | null;
  const pbcCNum = el.querySelector('#p-bc-contrast-num') as HTMLInputElement | null;
  const pbcCVal = el.querySelector('#p-bc-contrast-val');
  const pbcLeg = el.querySelector('#p-bc-legacy') as HTMLInputElement | null;

  if (pbcB && pbcBNum) {
    const syncB = (val: number, commit: boolean) => {
      pbcB.value = String(val);
      pbcBNum.value = String(val);
      if (pbcBVal) pbcBVal.textContent = String(val);
      h.editBrightnessContrast(n, { brightness: val }, commit);
    };
    pbcB.oninput = () => syncB(Number(pbcB.value), false);
    pbcB.onchange = () => syncB(Number(pbcB.value), true);
    pbcBNum.oninput = () => syncB(Number(pbcBNum.value), false);
    pbcBNum.onchange = () => syncB(Number(pbcBNum.value), true);
    pbcBNum.onkeydown = (e) => { if (e.key === 'Enter') { syncB(Number(pbcBNum.value), true); pbcBNum.blur(); } };
  }

  if (pbcC && pbcCNum) {
    const syncC = (val: number, commit: boolean) => {
      pbcC.value = String(val);
      pbcCNum.value = String(val);
      if (pbcCVal) pbcCVal.textContent = String(val);
      h.editBrightnessContrast(n, { contrast: val }, commit);
    };
    pbcC.oninput = () => syncC(Number(pbcC.value), false);
    pbcC.onchange = () => syncC(Number(pbcC.value), true);
    pbcCNum.oninput = () => syncC(Number(pbcCNum.value), false);
    pbcCNum.onchange = () => syncC(Number(pbcCNum.value), true);
    pbcCNum.onkeydown = (e) => { if (e.key === 'Enter') { syncC(Number(pbcCNum.value), true); pbcCNum.blur(); } };
  }

  if (pbcLeg) {
    pbcLeg.onchange = () => h.editBrightnessContrast(n, { useLegacy: pbcLeg.checked }, true);
  }

  const slider = el.querySelector('#p-op') as HTMLInputElement;
  const label = el.querySelector('#p-op-v') as HTMLElement;
  let start: number | null = null;
  if (slider) {
    slider.oninput = () => {
      if (start === null) start = n.opacity;
      if (label) label.textContent = `${slider.value}%`;
      h.setOpacityPreview(n, Number(slider.value) / 100);
    };
    slider.onchange = () => {
      if (start === null) return;
      h.commitOpacity(n, start, Number(slider.value) / 100);
      start = null;
    };
  }

  // Restore previous focus if available
  if (prevActiveId) {
    const nextEl = el.querySelector('#' + prevActiveId) as HTMLElement | null;
    if (nextEl) nextEl.focus();
  }
}
