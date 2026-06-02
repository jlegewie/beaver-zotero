import { ID_PREFIXES } from "../../../beaver-extract/schema/schema";
import {
    collectEpubDomItems,
    normalizeEpubText,
} from "./domWalk";
import type {
    EpubItem,
    EpubSection,
    EpubSentence,
} from "./schema";

export interface EpubExtractionCounters {
    itemCounters: Map<string, number>;
    sentenceCounter: number;
    itemOrder: number;
}

export interface ParseEpubSectionInput {
    doc: XMLDocument | Document;
    sectionIndex: number;
    rawHref: string;
    counters: EpubExtractionCounters;
}

const SENTENCE_BEARING_KINDS = new Set([
    "text",
    "list_item",
    "caption",
    "footnote",
]);

/** Parse one EPUB section document into ordered, document-global items. */
export function parseEpubSection(input: ParseEpubSectionInput): EpubSection {
    const body = findSectionBody(input.doc);
    if (!body) {
        return { index: input.sectionIndex, rawHref: input.rawHref, items: [] };
    }

    const items: EpubItem[] = [];
    for (const candidate of collectEpubDomItems(body)) {
        const item: EpubItem = {
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
            item.sentences = splitEpubSentences(candidate.text).map((sentenceText) => ({
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

/** Split EPUB prose into sentence-sized strings with a replaceable local splitter. */
export function splitEpubSentences(text: string): string[] {
    const normalized = normalizeEpubText(text);
    if (!normalized) return [];

    const matches = normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
    return (matches ?? [normalized])
        .map((part) => normalizeEpubText(part))
        .filter((part) => part.length > 0);
}

/** Create mutable counters shared across section parsing for document-global ids. */
export function createEpubExtractionCounters(): EpubExtractionCounters {
    return {
        itemCounters: new Map(),
        sentenceCounter: 0,
        itemOrder: 0,
    };
}

function nextItemId(counters: EpubExtractionCounters, kind: EpubItem["kind"]): string {
    const prefix = ID_PREFIXES[kind];
    const next = (counters.itemCounters.get(prefix) ?? 0) + 1;
    counters.itemCounters.set(prefix, next);
    return `${prefix}${next}`;
}

function nextSentenceId(counters: EpubExtractionCounters): string {
    counters.sentenceCounter += 1;
    return `${ID_PREFIXES.sentence}${counters.sentenceCounter}`;
}

function sectionLabel(doc: XMLDocument | Document): string | undefined {
    const title = doc.querySelector("title");
    const text = normalizeEpubText(title?.textContent);
    return text || undefined;
}

function findSectionBody(doc: XMLDocument | Document): Element | null {
    return doc.body ?? doc.querySelector("body");
}
