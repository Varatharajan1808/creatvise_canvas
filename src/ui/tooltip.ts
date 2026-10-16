/**
 * Fast, modern floating tooltip system for Creatvise Canvas.
 * Supports active and disabled elements with keyboard shortcut badges.
 */

let tooltipEl: HTMLElement | null = null;
let currentTarget: HTMLElement | null = null;
let showTimer: number | null = null;
let lastHideTime = 0;

function createTooltipElement(): HTMLElement {
  let el = document.getElementById('app-tooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-tooltip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTooltipContent(rawText: string, isDisabled: boolean): string {
  // Extract keyboard shortcut in parentheses at the end, e.g. "Undo change (Ctrl+Z)"
  // Ignore plural endings like "(s)" or "(es)" or explanatory text
  const shortcutMatch = rawText.match(/\(([^)]+)\)$/);
  let mainText = rawText;
  let shortcutText = '';

  if (shortcutMatch) {
    const candidate = shortcutMatch[1].trim();
    const isShortcut =
      candidate.length > 0 &&
      !/^(s|es|optional|default)$/i.test(candidate) &&
      (/(Ctrl|Shift|Alt|Cmd|Meta|Delete|Del|Space|Enter|Esc|Backspace|Drag|\+)/i.test(candidate) ||
        candidate.length <= 3);

    if (isShortcut) {
      mainText = rawText.slice(0, shortcutMatch.index).trim();
      shortcutText = candidate;
    }
  }

  let html = `<span class="tip-label">${escapeHtml(mainText)}</span>`;

  if (shortcutText) {
    html += ` <kbd class="tip-kbd">${escapeHtml(shortcutText)}</kbd>`;
  }

  if (isDisabled) {
    html += ` <span class="tip-disabled-badge">Disabled</span>`;
  }

  return html;
}

function positionTooltip(target: HTMLElement) {
  if (!tooltipEl) return;

  const targetRect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const margin = 8;

  let top: number;
  let left = targetRect.left + (targetRect.width - tipRect.width) / 2;

  // Decide whether to place above or below
  if (targetRect.top < 65) {
    // Top bar: place below
    top = targetRect.bottom + margin;
  } else if (window.innerHeight - targetRect.bottom < 50) {
    // Bottom bar: place above
    top = targetRect.top - tipRect.height - margin;
  } else {
    // Default: place above target
    top = targetRect.top - tipRect.height - margin;
    if (top < margin) {
      top = targetRect.bottom + margin;
    }
  }

  // Horizontal clamping within window
  if (left < margin) {
    left = margin;
  } else if (left + tipRect.width > window.innerWidth - margin) {
    left = window.innerWidth - tipRect.width - margin;
  }

  tooltipEl.style.top = `${Math.round(top)}px`;
  tooltipEl.style.left = `${Math.round(left)}px`;
}

function showTooltip(target: HTMLElement) {
  if (!tooltipEl) tooltipEl = createTooltipElement();

  const text = target.dataset.tooltip || target.getAttribute('title') || '';
  if (!text.trim()) return;

  // Store title in dataset and remove native title to prevent double tooltip
  if (target.hasAttribute('title')) {
    target.dataset.tooltip = target.getAttribute('title')!;
    target.removeAttribute('title');
  }

  const isDisabled =
    (target as HTMLButtonElement).disabled === true ||
    target.hasAttribute('disabled') ||
    !!target.closest('[disabled]');

  tooltipEl.innerHTML = formatTooltipContent(target.dataset.tooltip || text, isDisabled);
  tooltipEl.classList.remove('tip-visible');

  // Fast show if recently switched from another tooltip (<250ms), otherwise 100ms
  const delay = Date.now() - lastHideTime < 250 ? 0 : 90;

  if (showTimer) window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    if (!tooltipEl || currentTarget !== target) return;
    positionTooltip(target);
    tooltipEl.classList.add('tip-visible');
    tooltipEl.setAttribute('aria-hidden', 'false');
  }, delay);
}

function hideTooltip() {
  if (showTimer) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  if (tooltipEl) {
    tooltipEl.classList.remove('tip-visible');
    tooltipEl.setAttribute('aria-hidden', 'true');
    lastHideTime = Date.now();
  }
  currentTarget = null;
}

/**
 * Initialize global tooltip listeners.
 */
export function initTooltips() {
  createTooltipElement();

  // Mouse / Pointer enter
  document.addEventListener(
    'pointerover',
    (e) => {
      const target = (e.target as HTMLElement | null)?.closest(
        '[title], [data-tooltip]',
      ) as HTMLElement | null;

      if (!target) {
        hideTooltip();
        return;
      }

      if (target !== currentTarget) {
        currentTarget = target;
        showTooltip(target);
      }
    },
    { passive: true },
  );

  // Mouse / Pointer leave
  document.addEventListener(
    'pointerout',
    (e) => {
      if (!currentTarget) return;
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !currentTarget.contains(related)) {
        hideTooltip();
      }
    },
    { passive: true },
  );

  // Hide on scroll, click or keypress
  window.addEventListener('scroll', hideTooltip, { passive: true });
  window.addEventListener('pointerdown', hideTooltip, { passive: true });
  window.addEventListener('keydown', hideTooltip, { passive: true });
}
