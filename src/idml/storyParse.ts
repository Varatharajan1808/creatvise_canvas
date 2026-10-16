/** Parse IDML story XML into plain text and character/paragraph styling. */



import type { IdmlColorMap } from './swatches';

import { resolveSwatchRef } from './swatches';

import {

  resolveParagraphTypography,

  resolveStoryTypography,

  type IdmlTextStyleResources,

} from './textStyles';



export interface ParsedIdmlStoryRun {

  text: string;

  fontSize: number;

  fontFamily: string;

  textColorHex: string;

  fontStyle?: string;

}



export interface ParsedIdmlStoryParagraph {

  text: string;

  runs: ParsedIdmlStoryRun[];

  leading?: number;

  tracking?: number;

  justification?: string;

}



export interface ParsedIdmlStory {

  text: string;

  fontSize: number;

  fontFamily: string;

  textColorHex: string;

  paragraphs: ParsedIdmlStoryParagraph[];

}



function getDOMParser(): DOMParser {

  const g = globalThis as unknown as { DOMParser?: typeof DOMParser };

  if (typeof g.DOMParser !== 'undefined') return new g.DOMParser();

  throw new Error('No DOMParser available');

}



export function decodeIdmlTextContent(raw: string): string {

  return raw

    .replace(/<\?ACE[^?]*\?>/g, '')

    .replace(/[\uFEFF\u200B-\u200D\u2060]/g, '')

    .replace(/\u2028/g, '\n')

    .replace(/\u2029/g, '\n')

    .replace(/&amp;/g, '&')

    .replace(/&lt;/g, '<')

    .replace(/&gt;/g, '>')

    .replace(/&quot;/g, '"')

    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

}



/** Map common IDML swatch references to hex (frame/text). */

export function idmlSwatchToHex(swatch: string | null | undefined): string | null {

  if (!swatch || swatch === 'n' || /None/i.test(swatch)) return null;

  if (/Black/i.test(swatch)) return '#000000';

  if (/Paper|White/i.test(swatch)) return '#ffffff';

  if (/Registration/i.test(swatch)) return '#000000';

  return null;

}



function localName(el: Element): string {

  return el.localName || el.nodeName.split(':').pop() || '';

}



function storyContentElement(root: Element): Element {

  const all = root.getElementsByTagName('*');

  for (let i = 0; i < all.length; i++) {

    const el = all[i];

    if (localName(el).toLowerCase() === 'story') return el;

  }

  return root;

}



function collectCharacterRangeText(charRange: Element): string {

  let out = '';

  for (let i = 0; i < charRange.childNodes.length; i++) {

    const node = charRange.childNodes[i];

    if (node.nodeType !== 1) continue;

    const el = node as Element;

    const ln = localName(el).toLowerCase();

    if (ln === 'content' && el.textContent != null) {

      out += decodeIdmlTextContent(el.textContent);

    } else if (ln === 'br') {

      out += '\n';

    }

  }

  return out;

}



function firstCharacterStyleRange(storyRoot: Element): Element | null {

  const ranges = storyRoot.getElementsByTagName('*');

  for (let i = 0; i < ranges.length; i++) {

    const el = ranges[i];

    if (localName(el).toLowerCase() === 'characterstylerange') return el;

  }

  return null;

}



/** Strip InDesign ACE PIs before DOM parse (invalid XML target name in strict parsers). */

export function sanitizeIdmlStoryXml(storyXml: string): string {

  return storyXml.replace(/<\?ACE[^?]*\?>/g, '');

}



export function parseStoryFromXml(

  storyXml: string,

  colors: IdmlColorMap = new Map(),

  textStyles?: IdmlTextStyleResources,

): ParsedIdmlStory {

  const doc = getDOMParser().parseFromString(sanitizeIdmlStoryXml(storyXml), 'application/xml');

  const storyEl = storyContentElement(doc.documentElement);



  const paragraphs: ParsedIdmlStoryParagraph[] = [];



  for (let i = 0; i < storyEl.childNodes.length; i++) {

    const node = storyEl.childNodes[i];

    if (node.nodeType !== 1) continue;

    const el = node as Element;

    if (localName(el).toLowerCase() !== 'paragraphstylerange') continue;



    const paragraphStyleRef = el.getAttribute('AppliedParagraphStyle');

    const paraTypoBase = textStyles ? resolveParagraphTypography(paragraphStyleRef, textStyles) : {};
    const inlineJust = el.getAttribute('Justification');
    const paraTypo = {
      ...paraTypoBase,
      ...(inlineJust ? { justification: inlineJust } : {}),
    };



    const runs: ParsedIdmlStoryRun[] = [];

    let paraText = '';



    for (let j = 0; j < el.childNodes.length; j++) {

      const cNode = el.childNodes[j];

      if (cNode.nodeType !== 1) continue;

      const charRange = cNode as Element;

      if (localName(charRange).toLowerCase() !== 'characterstylerange') continue;



      const runText = collectCharacterRangeText(charRange);

      paraText += runText;

      const characterStyleRef = charRange.getAttribute('AppliedCharacterStyle');



      if (textStyles) {

        const resolved = resolveStoryTypography(

          paragraphStyleRef,

          characterStyleRef,

          charRange,

          textStyles,

          colors,

        );

        runs.push({ text: runText, fontStyle: resolved.fontStyle, ...resolved });

      } else {

        const fontSize = Number(charRange.getAttribute('PointSize') || charRange.getAttribute('FontSize'));

        const fillSwatch = charRange.getAttribute('FillColor') || charRange.getAttribute('StrokeColor');

        const textColorHex = resolveSwatchRef(fillSwatch, colors) ?? idmlSwatchToHex(fillSwatch) ?? '#1e1e1e';

        let fontFamily = 'sans-serif';

        const props = charRange.getElementsByTagName('*');

        for (let k = 0; k < props.length; k++) {

          const p = props[k];

          if (localName(p).toLowerCase() === 'appliedfont') {

            const t = p.textContent?.trim();

            if (t) fontFamily = t;

          }

        }

        const fontStyle = charRange.getAttribute('FontStyle') ?? undefined;
        runs.push({

          text: runText,

          fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12,

          fontFamily,

          textColorHex,

          fontStyle,

        });

      }

    }



    paragraphs.push({

      text: paraText,

      runs,

      leading: paraTypo.leading,

      tracking: paraTypo.tracking,

      justification: paraTypo.justification,

    });

  }



  if (paragraphs.length === 0) {

    const charRange = firstCharacterStyleRange(storyEl);

    const contentParts: string[] = [];

    const contentEls = storyEl.getElementsByTagName('*');

    for (let i = 0; i < contentEls.length; i++) {

      const cel = contentEls[i];

      if (localName(cel).toLowerCase() === 'content' && cel.textContent) {

        contentParts.push(decodeIdmlTextContent(cel.textContent));

      }

    }

    const text = contentParts.join('');

    const fontSize = charRange ? Number(charRange.getAttribute('PointSize') || charRange.getAttribute('FontSize')) : NaN;

    const fillSwatch = charRange?.getAttribute('FillColor') || charRange?.getAttribute('StrokeColor');

    const textColorHex = resolveSwatchRef(fillSwatch, colors) ?? idmlSwatchToHex(fillSwatch) ?? '#1e1e1e';

    let fontFamily = 'sans-serif';

    if (charRange) {

      const props = charRange.getElementsByTagName('*');

      for (let i = 0; i < props.length; i++) {

        const p = props[i];

        if (localName(p).toLowerCase() === 'appliedfont') {

          const t = p.textContent?.trim();

          if (t) fontFamily = t;

        }

      }

    }

    const run: ParsedIdmlStoryRun = {

      text,

      fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12,

      fontFamily,

      textColorHex,

    };

    paragraphs.push({ text, runs: [run] });

  }



  const text = paragraphs.map((p) => p.text).join('\n');

  const firstRun = paragraphs[0]?.runs[0];

  return {

    text,

    paragraphs,

    fontSize: firstRun?.fontSize ?? 12,

    fontFamily: firstRun?.fontFamily ?? 'sans-serif',

    textColorHex: firstRun?.textColorHex ?? '#1e1e1e',

  };

}


