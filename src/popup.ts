import { escapeHtml } from './utils';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface AlertModalOptions {
  title: string;
  message: string;
  type?: ToastType;
  confirmText?: string;
}

export interface ConfirmModalOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptModalOptions {
  title: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

export interface InfoItem {
  label: string;
  text: string;
  tag?: string;
  danger?: boolean;
}

export interface InfoListModalOptions {
  title: string;
  subtitle?: string;
  items: InfoItem[];
  confirmText?: string;
}

const ICONS = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
};

function getOrCreateToastContainer(): HTMLElement {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
  }
  return c;
}

function getOrCreateModalContainer(): HTMLElement {
  let c = document.getElementById('modal-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'modal-container';
    document.body.appendChild(c);
  }
  return c;
}

/**
 * Modern floating toast notification popup with auto-dismiss, icons, and progress animation.
 */
export function toast(message: string, typeOrError: ToastType | boolean = 'info', title?: string) {
  let type: ToastType = 'info';
  if (typeof typeOrError === 'boolean') {
    type = typeOrError ? 'error' : 'info';
  } else if (typeOrError) {
    type = typeOrError;
  }

  // Automatic type detection if generic info was passed
  if (type === 'info') {
    const lower = message.toLowerCase();
    if (lower.includes('exported') || lower.includes('restored') || lower.includes('saved')) {
      type = 'success';
    } else if (lower.includes('locked') || lower.includes('unsupported') || lower.includes('not supported') || lower.includes("can't be edited")) {
      type = 'warning';
    } else if (lower.includes('failed') || lower.includes('error') || lower.includes("couldn't")) {
      type = 'error';
    }
  }

  const container = getOrCreateToastContainer();
  const el = document.createElement('div');
  el.className = `toast-popup toast-${type}`;

  const defaultTitles: Record<ToastType, string> = {
    success: 'Success',
    error: 'Alert',
    warning: 'Notice',
    info: 'Info',
  };

  const headerTitle = title || defaultTitles[type];
  const iconSvg = ICONS[type];

  el.innerHTML = `
    <div class="toast-icon">${iconSvg}</div>
    <div class="toast-body">
      <div class="toast-title">${headerTitle}</div>
      <div class="toast-desc">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" aria-label="Close notification">${ICONS.close}</button>
    <div class="toast-bar"></div>
  `;

  container.appendChild(el);

  // Trigger enter animation on next frame
  requestAnimationFrame(() => {
    el.classList.add('show');
  });

  const duration = type === 'error' ? 5500 : 3500;
  let timer: number | null = window.setTimeout(dismiss, duration);

  function dismiss() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    el.classList.remove('show');
    el.classList.add('hide');
    window.setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 280);
  }

  const closeBtn = el.querySelector('.toast-close') as HTMLElement;
  if (closeBtn) closeBtn.onclick = dismiss;

  el.onmouseenter = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  el.onmouseleave = () => {
    if (timer === null) {
      timer = window.setTimeout(dismiss, 1800);
    }
  };
}

/**
 * Rich Modal Alert Popup with single confirm/close button.
 */
export function alertModal(opts: AlertModalOptions): Promise<void> {
  return new Promise((resolve) => {
    const container = getOrCreateModalContainer();
    const type = opts.type || 'info';
    const iconSvg = ICONS[type];

    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';

    overlay.innerHTML = `
      <div class="modal-card modal-${type}" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-icon-badge">${iconSvg}</div>
          <div class="modal-title">${escapeHtml(opts.title)}</div>
        </div>
        <div class="modal-content">${escapeHtml(opts.message)}</div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn-primary" id="m-ok">${escapeHtml(opts.confirmText || 'Got it')}</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      overlay.classList.remove('open');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve();
      }, 200);
    };

    const okBtn = overlay.querySelector('#m-ok') as HTMLButtonElement;
    okBtn?.focus();
    okBtn.onclick = cleanup;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        cleanup();
      }
    };
    window.addEventListener('keydown', onKey);
  });
}

/**
 * Rich Modal Confirm Popup with Cancel and Confirm buttons.
 */
export function confirmModal(opts: ConfirmModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const container = getOrCreateModalContainer();
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    const iconSvg = opts.danger ? ICONS.warning : ICONS.help;

    overlay.innerHTML = `
      <div class="modal-card ${opts.danger ? 'modal-danger' : 'modal-confirm'}" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-icon-badge ${opts.danger ? 'danger-badge' : ''}">${iconSvg}</div>
          <div class="modal-title">${escapeHtml(opts.title)}</div>
        </div>
        <div class="modal-content">${escapeHtml(opts.message)}</div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel" id="m-cancel">${escapeHtml(opts.cancelText || 'Cancel')}</button>
          <button class="modal-btn ${opts.danger ? 'modal-btn-danger' : 'modal-btn-primary'}" id="m-confirm">${escapeHtml(opts.confirmText || 'Confirm')}</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    let finished = false;
    const finish = (result: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKey);
      overlay.classList.remove('open');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }, 200);
    };

    const cancelBtn = overlay.querySelector('#m-cancel') as HTMLButtonElement;
    const confirmBtn = overlay.querySelector('#m-confirm') as HTMLButtonElement;

    cancelBtn.onclick = () => finish(false);
    confirmBtn.onclick = () => finish(true);
    confirmBtn.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };
    window.addEventListener('keydown', onKey);
  });
}

/**
 * Rich Modal Prompt Popup with Input Field.
 */
export function promptModal(opts: PromptModalOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const container = getOrCreateModalContainer();
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';

    overlay.innerHTML = `
      <div class="modal-card modal-prompt" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-icon-badge">${ICONS.edit}</div>
          <div class="modal-title">${escapeHtml(opts.title)}</div>
        </div>
        <div class="modal-content">
          <p class="modal-prompt-label">${escapeHtml(opts.message)}</p>
          <input type="text" class="modal-input" id="m-input" value="${escapeHtml(opts.defaultValue || '')}" placeholder="${escapeHtml(opts.placeholder || '')}" spellcheck="false" />
        </div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel" id="m-cancel">${escapeHtml(opts.cancelText || 'Cancel')}</button>
          <button class="modal-btn modal-btn-primary" id="m-submit">${escapeHtml(opts.confirmText || 'Save')}</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('open');
      const input = overlay.querySelector('#m-input') as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    });

    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKey);
      overlay.classList.remove('open');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }, 200);
    };

    const input = overlay.querySelector('#m-input') as HTMLInputElement;
    const cancelBtn = overlay.querySelector('#m-cancel') as HTMLButtonElement;
    const submitBtn = overlay.querySelector('#m-submit') as HTMLButtonElement;

    cancelBtn.onclick = () => finish(null);
    submitBtn.onclick = () => finish(input.value.trim());

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value.trim());
      }
    };
    window.addEventListener('keydown', onKey);
  });
}

/**
 * Rich Modal Info / List details popup (used for unsupported features & keyboard shortcuts).
 */
export function infoListModal(opts: InfoListModalOptions): Promise<void> {
  return new Promise((resolve) => {
    const container = getOrCreateModalContainer();
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';

    const itemsHtml = opts.items
      .map(
        (it) => `
      <div class="modal-list-item ${it.danger ? 'danger-item' : ''}">
        <div class="modal-item-head">
          <span class="modal-item-label">${escapeHtml(it.label)}</span>
          ${it.tag ? `<span class="modal-item-tag ${it.danger ? 'tag-warn' : ''}">${escapeHtml(it.tag)}</span>` : ''}
        </div>
        <div class="modal-item-desc">${escapeHtml(it.text)}</div>
      </div>
    `,
      )
      .join('');

    overlay.innerHTML = `
      <div class="modal-card modal-list" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-icon-badge">${ICONS.help}</div>
          <div>
            <div class="modal-title">${escapeHtml(opts.title)}</div>
            ${opts.subtitle ? `<div class="modal-subtitle">${escapeHtml(opts.subtitle)}</div>` : ''}
          </div>
        </div>
        <div class="modal-list-content">${itemsHtml}</div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn-primary" id="m-close">${escapeHtml(opts.confirmText || 'Close')}</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      overlay.classList.remove('open');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve();
      }, 200);
    };

    const closeBtn = overlay.querySelector('#m-close') as HTMLButtonElement;
    closeBtn?.focus();
    closeBtn.onclick = cleanup;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        cleanup();
      }
    };
    window.addEventListener('keydown', onKey);
  });
}

export interface FolderImportModalFile {
  relativePath: string;
  name: string;
  size?: number;
  format: 'psd' | 'ai';
}

export interface FolderImportModalOptions {
  folderName: string;
  importable: FolderImportModalFile[];
  skipped: Array<{ relativePath: string; name: string; reason: string }>;
  totalScanned: number;
}

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Folder import queue: user selects which .psd / .ai files to import. Returns selected indices or null (cancel).
 */
export function folderImportModal(opts: FolderImportModalOptions): Promise<number[] | null> {
  return new Promise((resolve) => {
    const container = getOrCreateModalContainer();
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';

    const filesHtml = opts.importable
      .map(
        (f, i) => `
        <label class="folder-file-row folder-file-row-selectable">
          <input type="checkbox" class="folder-file-check" data-idx="${i}" checked />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="folder-file-icon">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="folder-file-name" title="${escapeHtml(f.relativePath)}">${escapeHtml(f.relativePath)}</span>
          <span class="folder-file-fmt">${f.format === 'ai' ? 'AI' : 'PSD'}</span>
          ${f.size ? `<span class="folder-file-size">${formatBytes(f.size)}</span>` : ''}
        </label>
      `,
      )
      .join('');

    const skippedHtml =
      opts.skipped.length > 0
        ? `
        <div class="folder-skipped-block">
          <div class="folder-skipped-title">${opts.skipped.length} unsupported file(s) — not imported</div>
          ${opts.skipped
            .slice(0, 12)
            .map(
              (s) =>
                `<div class="folder-skipped-row" title="${escapeHtml(s.reason)}"><span>${escapeHtml(s.relativePath)}</span><span class="folder-skipped-reason">${escapeHtml(s.reason)}</span></div>`,
            )
            .join('')}
          ${opts.skipped.length > 12 ? `<div class="folder-skipped-more">…and ${opts.skipped.length - 12} more</div>` : ''}
        </div>`
        : '';

    overlay.innerHTML = `
      <div class="modal-card modal-folder-card" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-icon-badge folder-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/>
              <line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </div>
          <div>
            <div class="modal-title">Open Folder: ${escapeHtml(opts.folderName)}</div>
            <div class="modal-subtitle">Scanned ${opts.totalScanned} file(s) — ${opts.importable.length} supported (.psd / .ai)</div>
          </div>
        </div>
        <div class="modal-content">
          <p style="margin: 0 0 8px; font-size: 13px; color: var(--text-secondary);">
            Select documents to add to the canvas (existing documents stay open):
          </p>
          <div class="folder-select-actions">
            <button type="button" class="linkish-btn" id="m-all">Select all</button>
            <span aria-hidden="true">·</span>
            <button type="button" class="linkish-btn" id="m-none">Select none</button>
          </div>
          <div class="folder-file-container">
            ${filesHtml || '<p class="folder-empty-note">No .psd or .ai files found in this folder.</p>'}
          </div>
          ${skippedHtml}
        </div>
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel" id="m-cancel">Cancel</button>
          <button class="modal-btn modal-btn-primary" id="m-confirm" disabled>Import</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    const confirmBtn = overlay.querySelector('#m-confirm') as HTMLButtonElement;
    const checks = () => [...overlay.querySelectorAll<HTMLInputElement>('.folder-file-check')];

    const updateConfirm = () => {
      const n = checks().filter((c) => c.checked).length;
      confirmBtn.disabled = n === 0;
      confirmBtn.textContent = n ? `Import ${n} file${n === 1 ? '' : 's'}` : 'Import';
    };

    checks().forEach((c) => c.addEventListener('change', updateConfirm));
    overlay.querySelector('#m-all')?.addEventListener('click', () => {
      checks().forEach((c) => { c.checked = true; });
      updateConfirm();
    });
    overlay.querySelector('#m-none')?.addEventListener('click', () => {
      checks().forEach((c) => { c.checked = false; });
      updateConfirm();
    });
    updateConfirm();

    let finished = false;
    const finish = (result: number[] | null) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKey);
      overlay.classList.remove('open');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }, 200);
    };

    overlay.querySelector('#m-cancel')!.addEventListener('click', () => finish(null));
    confirmBtn.onclick = () => {
      const selected = checks()
        .filter((c) => c.checked)
        .map((c) => parseInt(c.dataset.idx ?? '-1', 10))
        .filter((i) => i >= 0);
      finish(selected);
    };
    confirmBtn.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    };
    window.addEventListener('keydown', onKey);
  });
}

/** @deprecated Use folderImportModal */
export function folderConfirmModal(opts: {
  folderName: string;
  files: Array<{ name: string; size?: number }>;
  totalScanned?: number;
}): Promise<boolean> {
  return folderImportModal({
    folderName: opts.folderName,
    importable: opts.files.map((f) => ({
      relativePath: f.name,
      name: f.name,
      size: f.size,
      format: 'psd',
    })),
    skipped: [],
    totalScanned: opts.totalScanned ?? opts.files.length,
  }).then((idx) => idx !== null && idx.length > 0);
}


