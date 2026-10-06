/**
 * What the Beaver agent sees on a PDF page, as drawable boxes.
 *
 * Projects one page of the structured document (the payload sent to the
 * backend) into the elements the model receives and can cite. The rules mirror
 * the backend's per-page citation XML (sentence mode, flat nesting, no
 * continuation merging, margin items dropped):
 *
 * - An item with sentences is seen as its sentences: `<s4.12>…</s4.12>`. The
 *   item id itself is not shown, except for tables, whose row sentences are
 *   nested inside `<table4.1>…</table4.1>`.
 * - An item without sentences is seen as one tag around its text: headings,
 *   unsplit paragraphs, equations (`<eq4.1>`) and figures (`<fig4.1>` around
 *   the label text found inside the figure, empty when there is none).
 * - Margin items (running heads, page numbers) never reach the model.
 *
 * Rects stay in the public extraction frame (top-left origin, `page.width` ×
 * `page.height`), which matches the page as the reader displays it.
 */

import type {
    DocumentItem,
    DocumentItemKind,
    Rect,
    Sentence,
    StructuredPage,
} from '@beaver/agent-core/extract/schema';

export type AgentViewBoxKind =
    | 'table'
    | 'figure'
    | 'equation'
    | 'table_row'
    | 'sentence'
    | 'item';

export interface AgentViewBox {
    kind: AgentViewBoxKind;
    /** The id the model sees and cites (`s4.12`, `table4.1`, `heading4.1`, …). */
    id: string;
    /** Kind of the extracted item the box belongs to. */
    itemKind: DocumentItemKind;
    /** Rects in the public extraction frame; one box may span several. */
    rects: Rect[];
    /** The tagged text the model receives for this element. */
    modelText: string;
    /** Alternates between neighbouring sentences (and table rows) so they stay distinguishable. */
    shade: 0 | 1;
}

export interface AgentViewPageCounts {
    tables: number;
    figures: number;
    equations: number;
    sentences: number;
    tableRows: number;
    items: number;
    /** Citable sentences without geometry, which can't be drawn. */
    unlocatedSentences: number;
}

export interface AgentViewPage {
    pageIndex: number;
    label?: string;
    width: number;
    height: number;
    boxes: AgentViewBox[];
    counts: AgentViewPageCounts;
}

const REGION_BOX_KIND: Partial<Record<DocumentItemKind, AgentViewBoxKind>> = {
    table: 'table',
    picture: 'figure',
    formula: 'equation',
};

/** Escape text the way the backend does before tagging it. */
function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tag(id: string, text: string): string {
    return `<${id}>${escapeXml(text)}</${id}>`;
}

function itemText(item: DocumentItem): string {
    return 'text' in item ? item.text ?? '' : '';
}

function itemSentences(item: DocumentItem): Sentence[] {
    if (!('sentences' in item) || !item.sentences?.length) return [];
    return [...item.sentences].sort((a, b) => a.order - b.order);
}

function emptyCounts(): AgentViewPageCounts {
    return {
        tables: 0,
        figures: 0,
        equations: 0,
        sentences: 0,
        tableRows: 0,
        items: 0,
        unlocatedSentences: 0,
    };
}

/** Build the agent's view of one structured page. */
export function buildAgentViewPage(page: StructuredPage): AgentViewPage {
    const boxes: AgentViewBox[] = [];
    const counts = emptyCounts();
    let sentenceShade = 0;

    const items = [...page.items]
        .filter((item) => item.kind !== 'margin')
        .sort((a, b) => a.order - b.order);

    for (const item of items) {
        const sentences = itemSentences(item);

        if (item.kind === 'table' && sentences.length > 0) {
            const rows = sentences.map((sentence) => `  ${tag(sentence.id, sentence.text)}`);
            boxes.push({
                kind: 'table',
                id: item.id,
                itemKind: item.kind,
                rects: [item.bbox],
                modelText: [`<${item.id}>`, ...rows, `</${item.id}>`].join('\n'),
                shade: 0,
            });
            counts.tables++;
            sentences.forEach((sentence, rowIndex) => {
                if (sentence.bboxes.length === 0) {
                    counts.unlocatedSentences++;
                    return;
                }
                boxes.push({
                    kind: 'table_row',
                    id: sentence.id,
                    itemKind: item.kind,
                    rects: sentence.bboxes,
                    modelText: tag(sentence.id, sentence.text),
                    shade: (rowIndex % 2) as 0 | 1,
                });
                counts.tableRows++;
            });
            continue;
        }

        if (sentences.length > 0) {
            for (const sentence of sentences) {
                if (sentence.bboxes.length === 0) {
                    counts.unlocatedSentences++;
                    continue;
                }
                boxes.push({
                    kind: 'sentence',
                    id: sentence.id,
                    itemKind: item.kind,
                    rects: sentence.bboxes,
                    modelText: tag(sentence.id, sentence.text),
                    shade: (sentenceShade++ % 2) as 0 | 1,
                });
                counts.sentences++;
            }
            continue;
        }

        const kind = REGION_BOX_KIND[item.kind] ?? 'item';
        boxes.push({
            kind,
            id: item.id,
            itemKind: item.kind,
            rects: [item.bbox],
            modelText: tag(item.id, itemText(item)),
            shade: 0,
        });
        if (kind === 'table') counts.tables++;
        else if (kind === 'figure') counts.figures++;
        else if (kind === 'equation') counts.equations++;
        else counts.items++;
    }

    return {
        pageIndex: page.index,
        label: page.label,
        width: page.width,
        height: page.height,
        boxes,
        counts,
    };
}

/** Sum the per-page counts of a document. */
export function totalAgentViewCounts(pages: AgentViewPage[]): AgentViewPageCounts {
    const total = emptyCounts();
    for (const page of pages) {
        for (const key of Object.keys(total) as (keyof AgentViewPageCounts)[]) {
            total[key] += page.counts[key];
        }
    }
    return total;
}
