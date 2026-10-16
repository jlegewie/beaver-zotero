/**
 * Worker-side splitter resolver.
 *
 * Translates a serializable `SentenceSplitterConfig` (sent across the
 * worker boundary as a plain object) into a synchronous
 * `SentenceSplitter` function the mapper can invoke.
 *
 * Fallback semantics: if sentencex init fails, log a warning and fall
 * back to the regex splitter so sentence-bbox extraction keeps working in
 * degraded environments (missing .wasm, broken WASM packaging, etc.).
 *
 * The returned splitter is invoked once per paragraph during mapping —
 * `applyPostProcessing` is applied here so the caller (the mapper)
 * can stay agnostic about which backend produced the ranges.
 */

import {
    simpleRegexSentenceSplit,
    type SentenceRange,
    type SentenceSplitter,
} from "../SentenceMapper";
import { applyPostProcessing, type PostProcessContext } from "../sentencePostprocess";
import {
    normalizeLanguageCode,
    sentencexBoundariesToCharRanges,
} from "../SentencexSplitter";
import type { SentenceSplitterConfig } from "../sentenceTypes";
import { ensureSentencex } from "./sentencexInit";
import { postLog } from "./errors";

/** Post-processing switches the PDF schema preset selects (see `PostProcessContext`). */
export interface SplitterOptions {
    captionLabels?: boolean;
}

export async function resolveSplitter(
    config: SentenceSplitterConfig,
    options: SplitterOptions = {},
): Promise<SentenceSplitter> {
    const post = (ranges: SentenceRange[], text: string, ctx: PostProcessContext | undefined) =>
        applyPostProcessing(ranges, text, options.captionLabels ? { ...ctx, captionLabels: true } : ctx);
    if (config.type === "simple") {
        return (text, ctx): SentenceRange[] => {
            const ranges = simpleRegexSentenceSplit(text);
            return post(ranges, text, ctx);
        };
    }

    // sentencex with simple-regex fallback. The init failure is logged via
    // the worker's log channel so the cause is still visible upstream.
    try {
        const mod = await ensureSentencex();
        const lang = normalizeLanguageCode(config.language);
        return (text, ctx): SentenceRange[] => {
            if (!text) return [];
            const boundaries = mod.get_sentence_boundaries(lang, text);
            if (!boundaries || boundaries.length === 0) return [];
            const ranges = sentencexBoundariesToCharRanges(text, boundaries);
            return post(ranges, text, ctx);
        };
    } catch (err) {
        postLog(
            "warn",
            `[worker] sentencex init failed, falling back to simple: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return (text, ctx): SentenceRange[] => {
            const ranges = simpleRegexSentenceSplit(text);
            return post(ranges, text, ctx);
        };
    }
}
