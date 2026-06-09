/**
 * Sentence splitting for DOM (EPUB/snapshot) extraction.
 *
 * Primary backend is the **same sentencex WASM** the PDF pipeline uses
 * (`chrome://beaver/content/lib/sentencex/`), so sentence boundaries are
 * consistent across PDF and DOM extraction. The module is loaded once on the
 * main thread; `splitSentences` then runs synchronously inside the section
 * parser. If the WASM cannot be loaded (or a split throws), it degrades to a
 * language-agnostic abbreviation-aware regex so extraction never fails.
 *
 * Call `ensureSentencexLoaded()` once before parsing a document and
 * `setSentenceLanguage()` with the document's language; both are no-ops for the
 * regex fallback.
 */

import { normalizeText } from "./domWalk";
import {
    normalizeLanguageCode,
    sentencexBoundariesToCharRanges,
    type SentencexBoundary,
} from "../../../beaver-extract/SentencexSplitter";
import { applyPostProcessing } from "../../../beaver-extract/sentencePostprocess";
import { logger } from "../../../utils/logger";

// Minimal surface of the wasm-bindgen module we use (mirrors the worker's
// `SentencexModule`); kept local so this file does not pull in worker code.
interface SentencexModule {
    initSync: (config: { module: ArrayBuffer | WebAssembly.Module }) => unknown;
    get_sentence_boundaries: (language: string, text: string) => SentencexBoundary[];
}

const SENTENCEX_FACTORY_URL =
    "chrome://beaver/content/lib/sentencex/sentencex_wasm.js";
const SENTENCEX_BINARY_URL =
    "chrome://beaver/content/lib/sentencex/sentencex_wasm_bg.wasm";

let modulePromise: Promise<SentencexModule | null> | null = null;
let loadedModule: SentencexModule | null = null;
let currentLanguage = "en";

async function loadSentencexModule(): Promise<SentencexModule | null> {
    try {
        const binary = await (await fetch(SENTENCEX_BINARY_URL)).arrayBuffer();
        // `webpackIgnore` keeps webpack from rewriting this into its chunk
        // loader: we need a native dynamic import of the chrome:// wasm-bindgen
        // ESM. The URL is held in a const (not a literal in the call) so tsc
        // does not try to resolve the chrome:// module. (These modules are
        // webpack-only; an esbuild path would also need `external:
        // ["chrome://*"]`.) `initSync` avoids the shim's import.meta.url /
        // fetch(.wasm) path.
        const factoryUrl = SENTENCEX_FACTORY_URL;
        const mod = (await import(/* webpackIgnore: true */ factoryUrl)) as unknown as SentencexModule;
        mod.initSync({ module: binary });
        return mod;
    } catch (error) {
        logger(
            `sentenceSplitter: sentencex WASM load failed, using regex fallback: ${
                error instanceof Error ? error.message : String(error)
            }`,
            2,
        );
        return null;
    }
}

/**
 * Load the sentencex WASM once (best-effort). Returns whether it is available;
 * when `false`, `splitSentences` uses the regex fallback.
 */
export async function ensureSentencexLoaded(): Promise<boolean> {
    if (loadedModule) return true;
    if (!modulePromise) modulePromise = loadSentencexModule();
    loadedModule = await modulePromise;
    return loadedModule !== null;
}

/** Set the language passed to sentencex (normalized; falls back to `en`). */
export function setSentenceLanguage(language: string | null | undefined): void {
    currentLanguage = normalizeLanguageCode(language);
}

/**
 * Split DOM prose into sentence-sized strings. Uses sentencex when loaded,
 * otherwise the abbreviation-aware regex fallback.
 */
export function splitSentences(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];

    if (loadedModule) {
        try {
            const boundaries = loadedModule.get_sentence_boundaries(currentLanguage, normalized);
            if (boundaries && boundaries.length > 0) {
                // Same post-processing the PDF path applies after sentencex:
                // merges label-only/decimal/reference over-splits for
                // citation-friendly boundaries.
                const ranges = applyPostProcessing(
                    sentencexBoundariesToCharRanges(normalized, boundaries),
                    normalized,
                );
                const sentences = ranges
                    .map((range) => normalizeText(normalized.slice(range.start, range.end)))
                    .filter((sentence) => sentence.length > 0);
                if (sentences.length > 0) return sentences;
            }
        } catch (error) {
            logger(
                `sentenceSplitter: sentencex split failed, using regex fallback: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                2,
            );
        }
    }

    return regexSplitSentences(normalized);
}

// ---------------------------------------------------------------------------
// Regex fallback — abbreviation-aware, language-agnostic
// ---------------------------------------------------------------------------

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
 * Replaceable local sentence splitter used when sentencex is unavailable.
 *
 * Boundaries are terminal punctuation (`.`/`!`/`?`) followed by whitespace or
 * end of text. A `.` boundary is suppressed when the preceding token is a single
 * capital letter (author initial) or a known abbreviation, so "Marvin A. Sweeney"
 * and "vol. 2" stay intact. A number is only treated as a list marker when it
 * *begins* the current sentence ("1. First point"), so a normal sentence-final
 * number ("the sample size was 42.") still splits.
 */
export function regexSplitSentences(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];

    const sentences: string[] = [];
    const boundary = /[.!?]+(?=\s|$)/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(normalized)) !== null) {
        const isDotOnly = /^\.+$/.test(match[0]);
        if (isDotOnly && isNonTerminalDot(normalized, match.index, start)) {
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
function isNonTerminalDot(text: string, dotIndex: number, segmentStart: number): boolean {
    // The whitespace-delimited token ending immediately before the period.
    const precedingWhitespace = text.lastIndexOf(" ", dotIndex - 1);
    const tokenStart = precedingWhitespace + 1;
    const token = text.slice(tokenStart, dotIndex);
    if (!token) return false;
    // Single capital letter — an author initial (e.g. "Marvin A.").
    if (/^[A-Z]$/.test(token)) return true;
    // Number — only a list/section marker when it begins the current sentence
    // ("1. First point"). A sentence-final number ("...was 42.") must still split,
    // so a number preceded by prose in this segment is a real boundary.
    if (/^\d+(\.\d+)*$/.test(token)) {
        return text.slice(segmentStart, tokenStart).trim().length === 0;
    }
    // Known abbreviation (period already consumed by the boundary match).
    return NON_TERMINAL_ABBREVIATIONS.has(token.toLowerCase());
}
