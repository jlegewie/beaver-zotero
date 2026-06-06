import { ID_PREFIXES } from "../../../beaver-extract/schema/schema";
import {
    collectDomItems,
    normalizeText,
} from "./domWalk";
import type {
    DomItem,
    DomSection,
} from "./schema";

export interface DomExtractionCounters {
    itemCounters: Map<string, number>;
    sentenceCounter: number;
    itemOrder: number;
}

export interface ParseDomSectionInput {
    doc: XMLDocument | Document;
    sectionIndex: number;
    rawHref: string;
    counters: DomExtractionCounters;
}

const SENTENCE_BEARING_KINDS = new Set([
    "text",
    "list_item",
    "caption",
    "footnote",
]);

/** Parse one DOM section document into ordered, document-global items. */
export function parseDomSection(input: ParseDomSectionInput): DomSection {
    const body = findSectionBody(input.doc);
    if (!body) {
        return { index: input.sectionIndex, rawHref: input.rawHref, items: [] };
    }

    const items: DomItem[] = [];
    for (const candidate of collectDomItems(body)) {
        const item: DomItem = {
            id: nextItemId(input.counters, candidate.kind),
            kind: candidate.kind,
            sectionIndex: input.sectionIndex,
            order: input.counters.itemOrder++,
            text: candidate.text,
            anchorId: candidate.anchorId,
        };
        if (candidate.level !== undefined) {
            item.level = candidate.level;
        }
        if (SENTENCE_BEARING_KINDS.has(candidate.kind)) {
            item.sentences = splitSentences(candidate.text).map((sentenceText) => ({
                id: nextSentenceId(input.counters),
                text: sentenceText,
            }));
        }
        items.push(item);
    }

    return {
        index: input.sectionIndex,
        rawHref: input.rawHref,
        label: sectionLabel(input.doc),
        items,
    };
}

/** Split DOM prose into sentence-sized strings with a replaceable local splitter. */
export function splitSentences(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];

    const matches = normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
    return (matches ?? [normalized])
        .map((part) => normalizeText(part))
        .filter((part) => part.length > 0);
}

/** Create mutable counters shared across section parsing for document-global ids. */
export function createDomCounters(): DomExtractionCounters {
    return {
        itemCounters: new Map(),
        sentenceCounter: 0,
        itemOrder: 0,
    };
}

function nextItemId(counters: DomExtractionCounters, kind: DomItem["kind"]): string {
    const prefix = ID_PREFIXES[kind];
    const next = (counters.itemCounters.get(prefix) ?? 0) + 1;
    counters.itemCounters.set(prefix, next);
    return `${prefix}${next}`;
}

function nextSentenceId(counters: DomExtractionCounters): string {
    counters.sentenceCounter += 1;
    return `${ID_PREFIXES.sentence}${counters.sentenceCounter}`;
}

function sectionLabel(doc: XMLDocument | Document): string | undefined {
    const title = doc.querySelector("title");
    const text = normalizeText(title?.textContent);
    return text || undefined;
}

function findSectionBody(doc: XMLDocument | Document): Element | null {
    return doc.body ?? doc.querySelector("body");
}
