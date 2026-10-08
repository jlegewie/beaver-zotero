/**
 * Input of the item-type model: the draft items of a whole document after
 * segmentation (step 2), with the typography, page layout and pipeline
 * signals its features read. A plain, serializable copy, so features are pure
 * functions of it (`features.ts`) and a fixture can pin them.
 *
 * Coordinates are in the upright working frame, rounded to 2 decimals.
 */

import type { MarginAnalysis } from "@beaver/agent-core/extract/types";
import { buildInputPage, type InputItem, type InputLine, type InputPage } from "../features/itemInput";
import { lineFace } from "../features/style";
import type { DraftDocument } from "../pipeline/itemPasses";
import type { RegionItemKind } from "../regions/regionItems";

export interface TypedLine extends InputLine {
    /** Font most glyphs are set in. */
    font: string;
    /** Shares of glyphs set bold and italic, 0–1 (2 decimals). */
    bold: number;
    italic: number;
}

export interface TypedItem extends InputItem {
    lines: TypedLine[];
    /**
     * Other pages of the margin window whose margin zones hold the item's
     * text (or its first line's), digits ignored: a running header or page
     * number the margin filter let through.
     */
    marginPages: number;
}

/** Upright box: [l, t, r, b]. */
export type Box = [number, number, number, number];

export interface TypedPage extends InputPage {
    items: TypedItem[];
    /** Column rectangles. */
    columns: Box[];
    /** Region items of the page (pictures, tables, formulas). */
    regions: { kind: RegionItemKind; bbox: Box }[];
}

export interface TypedDocument {
    pageCount: number;
    /**
     * Pages whose margin zones `marginPages` counts: the cross-page analysis
     * window, every page of the document in structured extraction.
     */
    marginWindow: number[];
    /** The document's primary body style. */
    body: { size: number; font: string; bold: boolean; italic: boolean };
    pages: TypedPage[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const box = (b: { l: number; t: number; r: number; b: number }): Box => [round2(b.l), round2(b.t), round2(b.r), round2(b.b)];

/** Longest text compared with margin text. */
const MARGIN_TEXT_MAX_CHARS = 200;

/** Text as repeated margin text is compared: case, digits and spacing ignored. */
export function repeatKey(text: string): string {
    return text.normalize("NFKC").toLowerCase().replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim();
}

/** Pages on which each margin text occurs (`repeatKey`). */
function marginTextPages(analysis: MarginAnalysis): Map<string, Set<number>> {
    const pages = new Map<string, Set<number>>();
    for (const elements of analysis.elements.values()) {
        for (const element of elements) {
            const key = repeatKey(element.text);
            if (!key) continue;
            const set = pages.get(key) ?? new Set<number>();
            set.add(element.pageIndex);
            pages.set(key, set);
        }
    }
    return pages;
}

/** The item-type input of a document's draft items. */
export function buildTypedDocument(doc: DraftDocument): TypedDocument {
    const margin = marginTextPages(doc.marginAnalysis);
    const otherPages = (key: string, pageIndex: number) => {
        const set = key ? margin.get(key) : undefined;
        return set ? set.size - (set.has(pageIndex) ? 1 : 0) : 0;
    };
    const body = doc.styleProfile.primaryBodyStyle;
    const pages = doc.pages.map((draft): TypedPage => {
        const input = buildInputPage(draft, doc.styleProfile);
        const items = input.items.map((item, i): TypedItem => {
            const lines = item.lines.map((line, k): TypedLine => {
                const face = lineFace(draft.items[i].lines[k]);
                return { ...line, font: face.font, bold: round2(face.bold), italic: round2(face.italic) };
            });
            const first = lines.length > 0 ? lines[0].text : item.text;
            // Margin text is a line or a row; longer items can't match it whole.
            const marginPages = Math.max(
                item.text.length <= MARGIN_TEXT_MAX_CHARS ? otherPages(repeatKey(item.text), draft.pageIndex) : 0,
                first.length <= MARGIN_TEXT_MAX_CHARS ? otherPages(repeatKey(first), draft.pageIndex) : 0,
            );
            return { ...item, lines, marginPages };
        });
        return {
            ...input,
            items,
            columns: (draft.columns ?? []).map(box),
            regions: (draft.regions ?? []).map((region) => ({ kind: region.kind, bbox: box(region.bbox) })),
        };
    });
    return {
        pageCount: doc.pageCount,
        marginWindow: [...doc.analysisPageIndices],
        body: {
            size: body?.size ?? 0,
            font: body?.font ?? "",
            bold: body?.bold ?? false,
            italic: body?.italic ?? false,
        },
        pages,
    };
}
