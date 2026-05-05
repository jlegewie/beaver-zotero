/**
 * sentencex-wasm adapter.
 *
 * Bridges the WASM sentence segmenter packaged at
 * `chrome://beaver/content/lib/sentencex/` into the project-native
 * `SentenceSplitter` contract (`(text) => SentenceRange[]`) used by
 * `SentenceMapper` and `ParagraphSentenceMapper`.
 *
 * Two responsibilities:
 *
 *   1. **Initialization caching.** The WASM module is loaded exactly
 *      once per Zotero session via `ChromeUtils.importESModule`. The
 *      factory `getSentencexSplitter` returns a cached promise; callers
 *      `await` it once and receive a purely synchronous splitter they
 *      can hand to `extractPageSentenceBBoxes`.
 *
 *   2. **Offset domain normalization.** sentencex-wasm currently returns
 *      `start_index`/`end_index` as JS string indices and also exposes
 *      `start_byte`/`end_byte` as UTF-8 byte offsets. The vendored
 *      TypeScript comments say the former are byte indices, so the adapter
 *      validates every reported char range against `boundary.text` before
 *      trusting it. If a future build only reports byte offsets, we fall
 *      back to the byte→JS-index conversion helpers below.
 *
 * Fallback policy: `getSentenceSplitterWithFallback` catches WASM init
 * failures and degrades to `simpleRegexSentenceSplit`. The lower-level
 * `getSentencexSplitter` does NOT swallow init errors — that's
 * deliberate, because a silent fallback would mask a real packaging bug
 * (e.g. missing .wasm in the XPI).
 */

import {
    simpleRegexSentenceSplit,
    type SentenceRange,
    type SentenceSplitter,
} from "./SentenceMapper";
import { applyPostProcessing } from "./sentencePostprocess";

// ---------------------------------------------------------------------------
// Types mirroring the vendored sentencex_wasm.d.ts
// ---------------------------------------------------------------------------
// Kept local so the file can type-check without referring into
// addon/content/lib (which is a chrome:// asset path, not a TS rootDir).

/** A single sentence boundary returned by `get_sentence_boundaries`. */
export interface SentencexBoundary {
    /** JS string index where the sentence starts (inclusive). */
    start_index: number;
    /** JS string index where the sentence ends (exclusive). */
    end_index: number;
    /** UTF-8 byte offset where the sentence starts (inclusive), when exposed. */
    start_byte?: number;
    /** UTF-8 byte offset where the sentence ends (exclusive), when exposed. */
    end_byte?: number;
    /** The sentence text exactly as it appears in the source string. */
    text: string;
    /** Punctuation that ended the sentence, if any. */
    boundary_symbol: string | null;
    /** Whether this boundary corresponds to a paragraph break in the input. */
    is_paragraph_break: boolean;
}

/** The minimal subset of the wasm-bindgen module surface this adapter uses. */
interface SentencexModule {
    segment: (language: string, text: string) => string[];
    get_sentence_boundaries: (
        language: string,
        text: string,
    ) => SentencexBoundary[];
}

// ---------------------------------------------------------------------------
// Session-cached WASM module
// ---------------------------------------------------------------------------

let modulePromise: Promise<SentencexModule> | null = null;

/**
 * Resolve the sentencex-wasm module via the chrome:// loader, caching the
 * promise for the rest of the session. Throws on init failure — callers
 * that want to degrade gracefully should use
 * `getSentenceSplitterWithFallback`.
 */
async function loadSentencexModule(): Promise<SentencexModule> {
    if (modulePromise) return modulePromise;
    modulePromise = (async () => {
        // ChromeUtils only exists inside a Zotero / Firefox chrome context.
        // The cast keeps the file portable for vitest, where the loader
        // path isn't exercised — unit tests instead test the pure helpers
        // (`buildByteOffsetTable`, `byteRangesToCharRanges`) directly.
        const ChromeUtils = (globalThis as any).ChromeUtils;
        if (!ChromeUtils?.importESModule) {
            throw new Error(
                "Sentencex: ChromeUtils.importESModule not available — " +
                    "this code path requires a Zotero/Firefox chrome context.",
            );
        }
        const { SentencexLoader } = ChromeUtils.importESModule(
            "chrome://beaver/content/modules/sentencex-loader.mjs",
        );
        return (await SentencexLoader.init(
            "chrome://beaver/content/",
        )) as SentencexModule;
    })();
    return modulePromise;
}

/**
 * Drop the cached sentencex module so its WASM memory can be GC'd.
 *
 * Wired into the plugin shutdown hook alongside `disposeMuPDF()`.
 * Safe to call multiple times.
 */
export async function disposeSentencex(): Promise<void> {
    if (!modulePromise) return;
    try {
        const ChromeUtils = (globalThis as any).ChromeUtils;
        if (ChromeUtils?.importESModule) {
            const { SentencexLoader } = ChromeUtils.importESModule(
                "chrome://beaver/content/modules/sentencex-loader.mjs",
            );
            await SentencexLoader.dispose();
        }
    } catch {
        // Loader already gone — ignore.
    }
    modulePromise = null;
}

// ---------------------------------------------------------------------------
// Byte → JS string offset conversion
// ---------------------------------------------------------------------------

/**
 * Build a cumulative UTF-8 byte-length table for `text` in a single pass.
 *
 * `byteOffsetAt[i]` is the number of UTF-8 bytes occupied by `text[0..i)`,
 * i.e. the byte offset corresponding to the JS code unit index `i`.
 * Length is `text.length + 1` so callers can look up both start (inclusive)
 * and end (exclusive) of a slice.
 *
 * **Performance.** O(n), one charCodeAt per code unit, single Uint32Array
 * allocation. For a typical PDF page (~5 kchars) this is microseconds.
 *
 * **UTF-16 → UTF-8 length rules used here:**
 *   - U+0000..U+007F          → 1 byte
 *   - U+0080..U+07FF          → 2 bytes
 *   - U+0800..U+FFFF (BMP)    → 3 bytes
 *   - U+10000..U+10FFFF       → 4 bytes (surrogate pair: counted entirely
 *                                on the high surrogate; low surrogate
 *                                contributes 0 bytes so its table entry
 *                                sits on the same byte offset as the next
 *                                full code point.)
 *
 * @internal Exported for unit testing.
 */
export function buildByteOffsetTable(text: string): Uint32Array {
    const table = new Uint32Array(text.length + 1);
    let byte = 0;
    for (let i = 0; i < text.length; i++) {
        table[i] = byte;
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            byte += 1;
        } else if (code < 0x800) {
            byte += 2;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            // High surrogate of an astral-plane code point.
            // The whole 4-byte UTF-8 sequence is charged here.
            byte += 4;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            // Low surrogate: bytes already accounted for on the
            // preceding high surrogate. No advance.
        } else {
            byte += 3;
        }
    }
    table[text.length] = byte;
    return table;
}

/**
 * Translate sentencex byte-indexed boundaries into JS string code-unit
 * ranges.
 *
 * Walks `byteOffsetAt` with a single monotonically increasing cursor, so
 * the conversion is O(text.length + boundaries.length) overall — not
 * O(boundaries × text). Sentencex returns boundaries in document order,
 * which makes this safe.
 *
 * Boundaries that map to an empty char range (e.g. landed inside the same
 * UTF-16 code unit) are dropped.
 *
 * @internal Exported for unit testing.
 */
export function byteRangesToCharRanges(
    boundaries: ReadonlyArray<SentencexBoundary>,
    byteOffsetAt: Uint32Array,
): SentenceRange[] {
    const ranges: SentenceRange[] = [];
    let cursor = 0;

    const advanceTo = (byteTarget: number): number => {
        // Advance cursor to the first index whose cumulative byte count
        // is >= byteTarget. Equivalent to a binary search but cheaper
        // because we only sweep forward across all boundaries combined.
        while (
            cursor < byteOffsetAt.length &&
            byteOffsetAt[cursor] < byteTarget
        ) {
            cursor++;
        }
        return cursor;
    };

    for (const b of boundaries) {
        const start = advanceTo(b.start_index);
        const end = advanceTo(b.end_index);
        if (end > start) ranges.push({ start, end });
    }
    return ranges;
}

function isFiniteOffset(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function textMatchesBoundary(
    text: string,
    boundary: SentencexBoundary,
    start: number,
    end: number,
): boolean {
    if (start < 0 || end < start || end > text.length) return false;
    return (
        typeof boundary.text !== "string" ||
        text.slice(start, end) === boundary.text
    );
}

function trimWhitespaceFromRange(
    text: string,
    range: SentenceRange,
): SentenceRange | null {
    let { start, end } = range;

    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;

    if (end <= start) return null;
    return { start, end };
}

/**
 * Normalize sentencex boundary objects to JS string ranges.
 *
 * `sentencex_wasm.js` exposes both `start_index`/`end_index` and
 * `start_byte`/`end_byte`. In the current build, the former are
 * already JS string indices. We therefore prefer validated char
 * indices and only use byte conversion as a fallback. Sentencex includes
 * separator/indentation whitespace in some boundaries, so returned ranges
 * are trimmed before downstream bbox mapping.
 *
 * @internal Exported for unit testing.
 */
export function sentencexBoundariesToCharRanges(
    text: string,
    boundaries: ReadonlyArray<SentencexBoundary>,
): SentenceRange[] {
    const ranges: SentenceRange[] = [];
    if (!text || boundaries.length === 0) return ranges;

    let byteOffsetAt: Uint32Array | null = null;
    const byteBoundaryFor = (
        boundary: SentencexBoundary,
    ): SentencexBoundary | null => {
        const start = isFiniteOffset(boundary.start_byte)
            ? boundary.start_byte
            : boundary.start_index;
        const end = isFiniteOffset(boundary.end_byte)
            ? boundary.end_byte
            : boundary.end_index;
        if (!isFiniteOffset(start) || !isFiniteOffset(end)) return null;
        return {
            ...boundary,
            start_index: start,
            end_index: end,
        };
    };

    for (const boundary of boundaries) {
        const { start_index: start, end_index: end } = boundary;
        if (
            isFiniteOffset(start) &&
            isFiniteOffset(end) &&
            end > start &&
            textMatchesBoundary(text, boundary, start, end)
        ) {
            const trimmed = trimWhitespaceFromRange(text, { start, end });
            if (trimmed) ranges.push(trimmed);
            continue;
        }

        const byteBoundary = byteBoundaryFor(boundary);
        if (!byteBoundary) continue;
        byteOffsetAt ??= buildByteOffsetTable(text);
        const fallback = byteRangesToCharRanges([byteBoundary], byteOffsetAt);
        for (const range of fallback) {
            const trimmed = trimWhitespaceFromRange(text, range);
            if (trimmed) ranges.push(trimmed);
        }
    }

    return ranges;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Resolve a sync `SentenceSplitter` backed by sentencex-wasm.
 *
 * The first call awaits WASM instantiation; subsequent calls return a
 * fresh closure over the cached module. The returned function is purely
 * synchronous and safe to pass to `extractPageSentenceBBoxes({ splitter })`.
 *
 * Throws if the WASM module fails to initialize. Use
 * `getSentenceSplitterWithFallback` for graceful degradation.
 *
 * @param language  - ISO-639 code (e.g. "en", "de", "ja"). Defaults to
 *                    "en". sentencex ships hand-tuned rules for ~30
 *                    languages and Wikipedia fallback chains for ~244;
 *                    unknown codes silently downgrade to the fallback,
 *                    so it's safe to pass arbitrary input.
 */
export async function getSentencexSplitter(
    language: string = "en",
): Promise<SentenceSplitter> {
    const mod = await loadSentencexModule();
    const lang = language || "en";
    return (text, context): SentenceRange[] => {
        if (!text) return [];
        const boundaries = mod.get_sentence_boundaries(lang, text);
        if (!boundaries || boundaries.length === 0) return [];
        const ranges = sentencexBoundariesToCharRanges(text, boundaries);
        return applyPostProcessing(ranges, text, context);
    };
}

/**
 * Best-effort variant: return a sentencex-backed splitter, or fall back
 * to `simpleRegexSentenceSplit` if WASM init fails.
 *
 * The fallback path keeps sentence-bbox extraction working in degraded
 * environments (e.g. a Zotero build that disables WASM, or a packaging
 * bug that drops the .wasm from the XPI). The init failure is logged
 * via `Zotero.debug` so the cause is still visible.
 */
export async function getSentenceSplitterWithFallback(
    language: string = "en",
): Promise<SentenceSplitter> {
    try {
        return await getSentencexSplitter(language);
    } catch (err) {
        try {
            (globalThis as any).Zotero?.debug?.(
                `[Beaver] sentencex-wasm failed to init, falling back ` +
                    `to simpleRegexSentenceSplit: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
            );
        } catch {
            // Logging is best effort.
        }
        // Reset the cached promise so a future call (after the underlying
        // problem is fixed) gets a fresh attempt instead of resolving to
        // the stale failure.
        modulePromise = null;
        return (text, context): SentenceRange[] => {
            const ranges = simpleRegexSentenceSplit(text);
            return applyPostProcessing(ranges, text, context);
        };
    }
}

// ---------------------------------------------------------------------------
// Language code normalization
// ---------------------------------------------------------------------------

/**
 * Map of ISO 639-2 / common alternate codes to ISO 639-1 codes used by
 * sentencex's per-language rule files. Only the high-volume cases —
 * sentencex falls back gracefully for anything not in this table.
 */
const ISO6392_TO_ISO6391: Readonly<Record<string, string>> = {
    eng: "en",
    ger: "de",
    deu: "de",
    fre: "fr",
    fra: "fr",
    spa: "es",
    ita: "it",
    por: "pt",
    rus: "ru",
    jpn: "ja",
    zho: "zh",
    chi: "zh",
    ara: "ar",
    nld: "nl",
    dut: "nl",
};

/**
 * Map of common English-language names to ISO 639-1 codes. Optional
 * sugar for hand-entered Zotero items where users typed the language
 * name instead of a code.
 */
const NAME_TO_ISO6391: Readonly<Record<string, string>> = {
    english: "en",
    german: "de",
    deutsch: "de",
    french: "fr",
    français: "fr",
    spanish: "es",
    español: "es",
    italian: "it",
    italiano: "it",
    portuguese: "pt",
    português: "pt",
    russian: "ru",
    japanese: "ja",
    chinese: "zh",
    arabic: "ar",
    dutch: "nl",
    nederlands: "nl",
};

/**
 * Normalize free-text Zotero `language` field values into a code that
 * sentencex understands.
 *
 * Real Zotero libraries contain a mix of:
 *   - "en", "de", "fr"            (CrossRef-style ISO 639-1)
 *   - "en-US", "en_GB"            (BCP-47-ish with region tags)
 *   - "eng", "ger", "fra", "jpn"  (PubMed / ISO 639-2)
 *   - "English", "Deutsch"        (manually entered names)
 *   - empty / arbitrary noise
 *
 * Strategy:
 *   1. Lowercase + trim.
 *   2. Strip BCP-47 region tags by splitting on `_` or `-` and keeping
 *      the primary subtag.
 *   3. If the result is a known ISO 639-2 code, map to ISO 639-1.
 *   4. If the result is a known English / native name, map to ISO 639-1.
 *   5. Otherwise return the result as-is.
 *
 * sentencex falls back gracefully on unknown codes, so step 5 is safe.
 *
 * Returns `"en"` for null / empty / undefined input.
 */
export function normalizeLanguageCode(raw: string | null | undefined): string {
    if (!raw) return "en";
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return "en";

    // Strip region tags (en-US → en, zh_TW → zh).
    const primary = trimmed.split(/[-_]/)[0];
    if (!primary) return "en";

    if (ISO6392_TO_ISO6391[primary]) return ISO6392_TO_ISO6391[primary];
    if (NAME_TO_ISO6391[primary]) return NAME_TO_ISO6391[primary];

    return primary;
}
