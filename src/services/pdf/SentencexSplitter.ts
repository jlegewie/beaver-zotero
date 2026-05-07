/**
 * sentencex-wasm adapter — main-thread loader.
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
 *   2. **Offset domain normalization.** Pure helpers
 *      (`buildByteOffsetTable`, `byteRangesToCharRanges`,
 *      `sentencexBoundariesToCharRanges`, `normalizeLanguageCode`,
 *      and the `SentencexBoundary` type) live in `./sentencexShared`
 *      so the worker bundle can reuse them without dragging in
 *      `ChromeUtils`. They are re-exported below for back-compat.
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
import {
    normalizeLanguageCode,
    sentencexBoundariesToCharRanges,
    type SentencexBoundary,
} from "./sentencexShared";

// ---------------------------------------------------------------------------
// Re-exports of the worker-safe pure helpers (back-compat with existing
// callers and tests that import directly from this module).
// ---------------------------------------------------------------------------
export {
    buildByteOffsetTable,
    byteRangesToCharRanges,
    sentencexBoundariesToCharRanges,
    normalizeLanguageCode,
} from "./sentencexShared";
export type { SentencexBoundary } from "./sentencexShared";

// ---------------------------------------------------------------------------
// Types specific to the main-thread loader
// ---------------------------------------------------------------------------

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
