/**
 * Passages cut from Beaver's extractions, with sentence locators.
 *
 * A passage packs paragraph-level units of one PDF page, or of one EPUB or
 * snapshot section, and records a citation span per sentence. The locator has
 * the backend's chunk-locator shape (`PdfChunkLocator`, `EpubChunkLocator`,
 * `SnapshotChunkLocator`), so the backend renders the same `<s…>` citation
 * markup and click targets as for read results.
 *
 * Span offsets are in Unicode code points, the unit the backend slices with.
 * Reference-list entries, figures and margins are left out.
 */

import type { Rect, StructuredDocument, TextItem } from '@beaver/agent-core/extract/schema';
import type { DomDocument } from '@beaver/agent-core/extract/document/dom/schema';

const TARGET_CHARS = 1300;
const MAX_CHARS = 2000;
/** A heading starts a new passage only once the current one holds this much text. */
const HEADING_BREAK_MIN_CHARS = 650;
const UNIT_SEPARATOR = '\n\n';
const PART_SEPARATOR = ' ';

/** Item kinds whose sentences render inside their item's tag. */
const WRAPPED_KINDS = new Set(['table', 'footnote', 'caption']);
const PDF_UNIT_KINDS = new Set(['text', 'list_item', 'caption', 'footnote', 'formula', 'table']);
const DOM_UNIT_KINDS = new Set(['text', 'list_item', 'caption', 'footnote', 'table']);

export interface PassageSpan {
    id: string;
    start: number;
    end: number;
    bboxes?: Rect[];
    page_index?: number;
    item_id?: string;
}

export interface BeaverPassage {
    text: string;
    locator: Record<string, unknown>;
}

interface Part {
    id: string;
    text: string;
    bboxes?: Rect[];
    itemId?: string;
    /** The sentence continues in the next part (split by a column break). */
    joinsNext?: boolean;
}

interface Unit {
    parts: Part[];
    itemId: string;
    /** Every item the unit covers, when a continued sentence joined several. */
    itemIds?: string[];
    heading: boolean;
    /** Sentences of an oversized unit continue it, joined with a space. */
    continues?: boolean;
    pageNumber?: number;
    anchorId?: string;
}

/** Length in code points (what Python's `len` counts). */
export function codePointLength(text: string): number {
    let surrogates = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) surrogates++;
    }
    return text.length - surrogates;
}

function unitLength(unit: Unit): number {
    return unit.parts.reduce((sum, part, i) => sum + part.text.length + (i ? PART_SEPARATOR.length : 0), 0);
}

/**
 * An oversized multi-sentence unit becomes one unit per sentence, joined with
 * spaces. The halves of a sentence split by a column break stay in one unit.
 */
function splitOversized(units: Unit[]): Unit[] {
    const out: Unit[] = [];
    for (const unit of units) {
        if (unit.parts.length > 1 && unitLength(unit) > MAX_CHARS) {
            let pieces: Part[] = [];
            unit.parts.forEach((part, i) => {
                pieces.push(part);
                if (part.joinsNext && i < unit.parts.length - 1) return;
                out.push({ ...unit, parts: pieces, continues: pieces[0] !== unit.parts[0] });
                pieces = [];
            });
        } else {
            out.push(unit);
        }
    }
    return out;
}

/**
 * Greedy packing: flush before a unit once the passage reaches the target, would
 * pass the maximum, or a heading arrives after enough text. Trailing headings
 * move to the next passage, so a heading never ends a passage.
 */
function packUnits(units: Unit[]): Unit[][] {
    const groups: Unit[][] = [];
    let current: Unit[] = [];
    let size = 0;
    for (const unit of splitOversized(units)) {
        const length = unitLength(unit);
        const join = current.length ? (unit.continues ? PART_SEPARATOR.length : UNIT_SEPARATOR.length) : 0;
        if (current.length && (
            size >= TARGET_CHARS
            || size + join + length > MAX_CHARS
            || (unit.heading && size >= HEADING_BREAK_MIN_CHARS)
        )) {
            const carried: Unit[] = [];
            while (current.length && current[current.length - 1].heading) carried.unshift(current.pop()!);
            if (current.length) groups.push(current);
            current = carried;
            size = current.reduce((sum, u, i) => sum + unitLength(u) + (i ? UNIT_SEPARATOR.length : 0), 0);
        }
        size += (current.length ? (unit.continues ? PART_SEPARATOR.length : UNIT_SEPARATOR.length) : 0) + length;
        current.push(unit);
    }
    if (current.length) groups.push(current);
    return groups;
}

/** Join a passage's units into text plus one span per part. */
function renderUnits(units: Unit[], pageIndex: number | null): { text: string; spans: PassageSpan[] } {
    let text = '';
    let offset = 0;
    const spans: PassageSpan[] = [];
    const append = (piece: string) => {
        text += piece;
        offset += codePointLength(piece);
    };
    units.forEach((unit, u) => {
        if (u) append(unit.continues ? PART_SEPARATOR : UNIT_SEPARATOR);
        unit.parts.forEach((part, p) => {
            if (p) append(PART_SEPARATOR);
            const start = offset;
            append(part.text);
            spans.push({
                id: part.id,
                start,
                end: offset,
                ...(part.bboxes ? { bboxes: part.bboxes } : {}),
                ...(pageIndex !== null && part.bboxes ? { page_index: pageIndex } : {}),
                ...(part.itemId ? { item_id: part.itemId } : {}),
            });
        });
    });
    return { text, spans };
}

function uniqueItemIds(units: Unit[]): string[] {
    return [...new Set(units.flatMap((unit) => unit.itemIds ?? [unit.itemId]))];
}

/** Last heading text before the passage's first body unit, or within it. */
function sectionOf(units: Unit[], before: string | null): string | null {
    let section = before;
    for (const unit of units) {
        if (unit.heading) section = unit.parts.map((part) => part.text).join(' ').replace(/^#+\s*/, '') || section;
    }
    return section;
}

/** Passages of a structured PDF extraction, one or more per page. */
type PdfItem = StructuredDocument['pages'][number]['items'][number];

function orderedSentences(item: PdfItem): NonNullable<TextItem['sentences']> {
    return 'sentences' in item && item.sentences?.length
        ? [...item.sentences].sort((a, b) => a.order - b.order).filter((s) => s.text.trim())
        : [];
}

/** Citation parts of one item: its sentences, or the whole item when it has none. */
function itemParts(item: PdfItem): Part[] {
    const sentences = orderedSentences(item);
    const wrap = WRAPPED_KINDS.has(item.kind) && sentences.length > 0 ? item.id : undefined;
    if (sentences.length) return sentences.map((s) => ({ id: s.id, text: s.text.trim(), bboxes: s.bboxes, itemId: wrap }));
    const text = 'text' in item ? item.text?.trim() : '';
    return text ? [{ id: item.id, text, bboxes: [item.bbox] }] : [];
}

/**
 * Items one continued passage spans from `start` (a sentence split by a column
 * break continues in the next text item, skipping footnotes printed between),
 * and the footnotes it skipped. Stays on one page, like the passage.
 */
function continuationGroup(items: PdfItem[], start: number): { group: number[]; held: number[] } {
    const group = [start];
    const held: number[] = [];
    for (;;) {
        const sentences = orderedSentences(items[group[group.length - 1]]);
        if (!sentences.length || !sentences[sentences.length - 1].joinWithNext) break;
        let next = group[group.length - 1] + 1;
        const skipped: number[] = [];
        while (next < items.length && items[next].kind === 'footnote') skipped.push(next++);
        if (next >= items.length || items[next].kind !== 'text' || !orderedSentences(items[next]).length) break;
        held.push(...skipped);
        group.push(next);
    }
    return { group, held };
}

/** Passages of a structured PDF extraction, one or more per page. */
export function structuredDocumentPassages(document: StructuredDocument): BeaverPassage[] {
    const passages: BeaverPassage[] = [];
    let section: string | null = null;
    for (const page of [...document.pages].sort((a, b) => a.index - b.index)) {
        const units: Unit[] = [];
        const items = [...page.items].sort((a, b) => a.order - b.order);
        const consumed = new Set<number>();
        const pushItems = (indices: number[]) => {
            const parts = indices.flatMap((index, position) => {
                const own = itemParts(items[index]);
                // The last sentence of every item but the last continues in the next one
                if (position < indices.length - 1 && own.length) own[own.length - 1] = { ...own[own.length - 1], joinsNext: true };
                return own;
            });
            if (!parts.length) return;
            const ids = indices.map((index) => items[index].id);
            units.push({ parts, itemId: ids[0], ...(ids.length > 1 ? { itemIds: ids } : {}), heading: false });
        };
        items.forEach((item, index) => {
            if (consumed.has(index)) return;
            if (item.kind === 'section_header') {
                const text = item.text.trim();
                if (text) units.push({ parts: [{ id: item.id, text, bboxes: [item.bbox] }], itemId: item.id, heading: true });
                return;
            }
            if (!PDF_UNIT_KINDS.has(item.kind)) return;
            // A continued sentence stays in one unit; footnotes printed inside it follow it
            const { group, held } = item.kind === 'text' ? continuationGroup(items, index) : { group: [index], held: [] };
            for (const i of [...group, ...held]) consumed.add(i);
            pushItems(group);
            for (const i of held) pushItems([i]);
        });
        const label = page.label ?? document.pageLabels?.[String(page.index)];
        for (const group of packUnits(units)) {
            const { text, spans } = renderUnits(group, page.index);
            const groupSection = sectionOf(group, section);
            passages.push({
                text,
                locator: {
                    content_kind: 'pdf',
                    pages: [{ page_index: page.index, ...(label ? { page_label: label } : {}) }],
                    spans,
                    item_ids: uniqueItemIds(group),
                    section: groupSection,
                },
            });
            section = groupSection;
        }
    }
    return passages;
}

/** Passages of an EPUB or snapshot extraction, never crossing a section. */
export function domDocumentPassages(document: DomDocument, contentKind: 'epub' | 'snapshot'): BeaverPassage[] {
    const passages: BeaverPassage[] = [];
    for (const section of [...document.sections].sort((a, b) => a.index - b.index)) {
        const units: Unit[] = [];
        let heading = section.label?.trim().replace(/^#+\s*/, '') || null;
        for (const item of [...section.items].sort((a, b) => a.order - b.order)) {
            const pageNumber = item.pageNumber ?? section.index + 1;
            if (item.kind === 'section_header') {
                const text = item.text?.trim();
                if (text) units.push({ parts: [{ id: item.id, text }], itemId: item.id, heading: true, pageNumber, anchorId: item.anchorId });
                continue;
            }
            if (!DOM_UNIT_KINDS.has(item.kind)) continue;
            const sentences = (item.sentences ?? []).filter((s) => s.text.trim());
            const parts: Part[] = sentences.length
                ? sentences.map((s) => ({ id: s.id, text: s.text.trim() }))
                : (item.text?.trim() ? [{ id: item.id, text: item.text.trim() }] : []);
            if (parts.length) units.push({ parts, itemId: item.id, heading: false, pageNumber, anchorId: item.anchorId });
        }
        for (const group of packUnits(units)) {
            const { text, spans } = renderUnits(group, null);
            const groupSection = sectionOf(group, heading);
            heading = groupSection;
            const pageNumbers = [...new Set(group.map((unit) => unit.pageNumber).filter((n): n is number => typeof n === 'number'))];
            const anchorId = group.find((unit) => unit.anchorId)?.anchorId ?? null;
            const common = { anchor_id: anchorId, page_numbers: pageNumbers, spans, item_ids: uniqueItemIds(group), section: groupSection };
            passages.push({
                text,
                locator: contentKind === 'epub'
                    ? { content_kind: 'epub', section_index: section.index, section_href: section.rawHref, section_label: section.label ?? null, ...common }
                    : { content_kind: 'snapshot', ...common },
            });
        }
    }
    return passages;
}
