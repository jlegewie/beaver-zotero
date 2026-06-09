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

// Lowercased tokens (trailing period stripped) that commonly precede a period
// without ending a sentence. Keeps author initials, scholarly abbreviations,
// and units from fragmenting prose at every dot.
const NON_TERMINAL_ABBREVIATIONS = new Set([
    // Titles / names
    "mr", "mrs", "ms", "dr", "prof", "st", "rev", "fr", "sr", "jr", "hon",
    // Scholarly / bibliographic
    "vol", "vols", "ed", "eds", "trans", "ch", "chs", "p", "pp", "no", "nos",
    "v", "vv", "n", "nn", "col", "cols", "fig", "figs", "cf", "viz", "vs",
    "al", "ibid", "op", "cit", "etc", "ca", "approx", "esp", "cap", "sec",
    "i.e", "e.g", "i.e.", "e.g.", "c", "ad", "bc", "ce", "bce",
    // Units / misc
    "cm", "mm", "km", "kg", "lit",
]);

/**
 * Split DOM prose into sentence-sized strings with a replaceable local splitter.
 *
 * Boundaries are terminal punctuation (`.`/`!`/`?`) followed by whitespace or
 * end of text. A `.` boundary is suppressed when the preceding token is a single
 * capital letter (author initial), a known abbreviation, or a bare number (list
 * marker), so "Marvin A. Sweeney", "p. 45", and "vol. 2" stay intact.
 */
export function splitSentences(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];

    const sentences: string[] = [];
    const boundary = /[.!?]+(?=\s|$)/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(normalized)) !== null) {
        const isDotOnly = /^\.+$/.test(match[0]);
        if (isDotOnly && isNonTerminalDot(normalized, match.index)) {
            continue;
        }
        const end = match.index + match[0].length;
        const sentence = normalizeText(normalized.slice(start, end));
        if (sentence) sentences.push(sentence);
        start = end;
    }
    const tail = normalizeText(normalized.slice(start));
    if (tail) sentences.push(tail);
    return sentences.length > 0 ? sentences : [normalized];
}

/** Decide whether a `.` at `dotIndex` is an abbreviation/initial rather than a sentence end. */
function isNonTerminalDot(text: string, dotIndex: number): boolean {
    // The whitespace-delimited token ending immediately before the period.
    const precedingWhitespace = text.lastIndexOf(" ", dotIndex - 1);
    const token = text.slice(precedingWhitespace + 1, dotIndex);
    if (!token) return false;
    // Single capital letter — an author initial (e.g. "Marvin A.").
    if (/^[A-Z]$/.test(token)) return true;
    // Bare or multi-level number — a list/section marker (e.g. "1." "182." "3.1.").
    if (/^\d+(\.\d+)*$/.test(token)) return true;
    // Known abbreviation (period already consumed by the boundary match).
    return NON_TERMINAL_ABBREVIATIONS.has(token.toLowerCase());
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
    // Prefer the first in-body heading: it is the chapter/section title. The
    // <head><title> is frequently the book title repeated across every section,
    // so it is only a fallback.
    const body = findSectionBody(doc);
    const heading = body?.querySelector("h1, h2, h3, h4, h5, h6");
    const headingText = normalizeText(heading?.textContent);
    if (headingText) return headingText;

    const title = doc.querySelector("title");
    const text = normalizeText(title?.textContent);
    return text || undefined;
}

function findSectionBody(doc: XMLDocument | Document): Element | null {
    return doc.body ?? doc.querySelector("body");
}
