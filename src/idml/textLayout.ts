/** Word-wrap and line metrics for IDML text rasterization (local frame coordinates). */

export type CanvasMeasureContext = Pick<
  CanvasRenderingContext2D,
  'measureText' | 'font' | 'letterSpacing'
>;

export interface IdmlTextLayoutOptions {
  maxWidth: number;
  maxHeight: number;
  fontSizePt: number;
  leadingPt?: number;
  tracking?: number;
  insetTop?: number;
  insetLeft?: number;
  insetBottom?: number;
  insetRight?: number;
  justification?: string;
}

export interface IdmlLaidOutLine {
  text: string;
  x: number;
  y: number;
  width: number;
}

function canvasJustification(just?: string): CanvasTextAlign {
  const j = (just ?? 'LeftAlign').toLowerCase();
  if (j.includes('center') || j.includes('centre')) return 'center';
  if (j.includes('right')) return 'right';
  return 'left';
}

function applyTracking(ctx: CanvasMeasureContext, tracking: number | undefined, fontSizePt: number): void {
  const t = tracking ?? 0;
  if (t === 0) {
    try {
      ctx.letterSpacing = '0px';
    } catch {
      /* older canvas */
    }
    return;
  }
  const px = (t / 1000) * fontSizePt;
  try {
    ctx.letterSpacing = `${px}px`;
  } catch {
    /* ignore */
  }
}

/** Split on hard breaks, then wrap each paragraph to maxWidth. */
export function layoutIdmlTextLines(
  ctx: CanvasMeasureContext,
  text: string,
  opts: IdmlTextLayoutOptions,
): IdmlLaidOutLine[] {
  const insetTop = opts.insetTop ?? 0;
  const insetLeft = opts.insetLeft ?? 0;
  const insetBottom = opts.insetBottom ?? 0;
  const insetRight = opts.insetRight ?? 0;
  const innerW = Math.max(0, opts.maxWidth - insetLeft - insetRight);
  const innerH = Math.max(0, opts.maxHeight - insetTop - insetBottom);
  const lineHeight = Math.max(opts.fontSizePt, opts.leadingPt ?? opts.fontSizePt * 1.2);
  const align = canvasJustification(opts.justification);
  applyTracking(ctx, opts.tracking, opts.fontSizePt);

  const wrapped: string[] = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    if (innerW <= 0) {
      wrapped.push(para);
      continue;
    }
    if (para.trim() === '') {
      wrapped.push('');
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(trial).width > innerW) {
        wrapped.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) wrapped.push(line);
  }

  const lines: IdmlLaidOutLine[] = [];
  let y = insetTop;
  for (const lineText of wrapped) {
    if (y > insetTop + innerH) break;
    const w = ctx.measureText(lineText).width;
    let x = insetLeft;
    if (align === 'center') x = insetLeft + Math.max(0, (innerW - w) / 2);
    else if (align === 'right') x = insetLeft + Math.max(0, innerW - w);
    lines.push({ text: lineText, x, y, width: w });
    y += lineHeight;
  }
  return lines;
}
