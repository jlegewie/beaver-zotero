/**
 * Pure text language detector for the sentence-extraction pipeline.
 *
 * Inputs are a UTF-8 sample (caller-built; typically the analysis-window
 * body text after smart-margin removal). Output is a normalized ISO 639-1
 * code plus a `source` tag for tracing where the decision came from.
 *
 * The detector is deliberately Zotero/MuPDF agnostic — easy to unit-test,
 * easy to swap. The only runtime dependency is `eld` (extrasmall build),
 * loaded via a `webpackMode: "eager"` dynamic import so the dataset
 * inlines into the main reactBundle (Zotero's HTTP handler context has
 * no `document.head`, which breaks webpack's default JSONP chunk loader).
 */

import { normalizeLanguageCode } from "./SentencexSplitter";

export type DetectSource =
    /** Caller passed a splitter directly; language is unknown to the pipeline. */
    | "caller-splitter"
    /** Caller passed an explicit `language`. */
    | "explicit"
    /** Decided by Unicode script frequency, without consulting eld. */
    | "script"
    /** Decided by the `eld` classifier. */
    | "eld"
    /** Detection failed or produced a non-allowlisted code; fallback used. */
    | "fallback"
    /** Detection failed and no fallback was provided; defaulted to "en". */
    | "default";

export interface DetectResult {
    /** Normalized ISO 639-1 code, or `null` for source `"caller-splitter"`. */
    language: string | null;
    source: DetectSource;
}

export interface DetectOptions {
    /** Used when detection is too sparse or rejected by the allowlist gate. */
    fallback?: string;
    /** Minimum letter count required to attempt detection. Default 200. */
    minLetters?: number;
}

/**
 * Languages we are willing to *act on* when they come from automatic
 * detection. Policy-based, not a quality tier:
 *   - Codes that overlap with eld's 60-language coverage.
 *   - Codes that are commonly seen in academic libraries and that
 *     sentencex either ships first-class rules for or routes through
 *     its Wikipedia-derived fallback chain (per the upstream
 *     wikimedia/sentencex 240+-language claim).
 *
 * Detection results outside this set degrade to the caller-provided
 * fallback (typically Zotero metadata) or "en". Explicit `language`
 * from a caller bypasses this gate entirely — the gate constrains
 * *detected* outputs only.
 *
 * Notes:
 *   - `id` (Indonesian) is NOT in eld's 60-language list; only `ms`
 *     (Malay) is. eld will never produce `id`; documents written in
 *     Indonesian resolve to `ms`. Add `ms` if/when we want to accept
 *     them via the detection path.
 *   - Empirical per-language splitting quality on fixture PDFs is the
 *     audit signal. Use the trace endpoint
 *     (`/beaver/test/pdf-pipeline-trace`) to verify sentence
 *     boundaries on a representative document for each new code, and
 *     drop any code whose Wikipedia-fallback rules produce poor
 *     boundaries (recorded in the PR description).
 */
export const SENTENCEX_ACCEPTED_DETECTED_LANGUAGES: ReadonlySet<string> =
    new Set([
        "en",
        "de",
        "fr",
        "es",
        "it",
        "pt",
        "ru",
        "uk",
        "ja",
        "zh",
        "ar",
        "nl",
        "ko",
        "sv",
        "da",
        "no",
        "fi",
        "pl",
        "cs",
        "tr",
        "he",
        "el",
        "hi",
        "th",
        "vi",
        "hu",
    ]);

const DEFAULT_MIN_LETTERS = 200;
// eld's accuracy plateau on academic prose flattens well below this
// threshold (per the upstream README, even 140-char tweet samples hit
// 99.3%). 3 KB of letters keeps the analysis-window walk short on
// long PDFs while staying comfortably above eld's reliable-input floor.
const SAMPLE_LETTER_CAP = 3000;
// Threshold for "this non-Latin script is the document's primary
// language." Set low because academic PDFs in non-Latin scripts almost
// always include an English abstract + author/affiliation block in
// Latin (empirically ~25-45% of first-page letters across our ZH / JA /
// KO / AR fixtures). Anything above this share of an unambiguous
// script means the document is in that script; the Latin block is
// metadata, not the primary language.
const SCRIPT_DOMINANCE = 0.3;
// Within the CJK family, even a small share of kana is a strong vote
// for Japanese over Chinese. Computed against the kana+han combined
// count, not against total letters, so it survives the Latin abstract.
const KANA_SHARE_OF_CJK = 0.1;
// Lowered threshold for "strip Latin before feeding eld": when a
// disambiguation-script (Cyrillic / Arabic / Devanagari) is at least
// this fraction of letters, drop Latin codepoints from the eld input
// so eld picks the right language within the script family without
// being poisoned by an English abstract.
const NON_LATIN_PRESENCE_FOR_STRIP = 0.3;

interface ScriptTally {
    total: number;
    latin: number;
    cyrillic: number;
    han: number;
    hiragana: number;
    katakana: number;
    hangul: number;
    arabic: number;
    hebrew: number;
    greek: number;
    thai: number;
    devanagari: number;
}

/**
 * Walk the sample once and count letter codepoints per script bucket.
 * Also caps the total at `SAMPLE_LETTER_CAP` letters so eld sees a
 * compact, signal-dense input.
 */
function tallyScripts(text: string): { tally: ScriptTally; capped: string } {
    const tally: ScriptTally = {
        total: 0,
        latin: 0,
        cyrillic: 0,
        han: 0,
        hiragana: 0,
        katakana: 0,
        hangul: 0,
        arabic: 0,
        hebrew: 0,
        greek: 0,
        thai: 0,
        devanagari: 0,
    };
    let cappedEnd = text.length;
    let lettersSeen = 0;
    for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i)!;
        const step = cp > 0xffff ? 2 : 1;
        // Skip ASCII control + space fast-path.
        if (cp < 0x80) {
            // a-z A-Z
            if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
                tally.latin++;
                tally.total++;
                lettersSeen++;
                if (lettersSeen >= SAMPLE_LETTER_CAP && cappedEnd === text.length) {
                    cappedEnd = i + step;
                }
            }
            i += step;
            continue;
        }
        // Latin Extended (ranges that academic prose actually hits).
        if (
            (cp >= 0xc0 && cp <= 0x024f) ||
            (cp >= 0x1e00 && cp <= 0x1eff)
        ) {
            tally.latin++;
        } else if (cp >= 0x0400 && cp <= 0x04ff) {
            tally.cyrillic++;
        } else if (cp >= 0x0370 && cp <= 0x03ff) {
            // Excludes the COMBINING set proper (we still over-count
            // marks here, which is fine for ratio detection).
            tally.greek++;
        } else if (cp >= 0x0590 && cp <= 0x05ff) {
            tally.hebrew++;
        } else if (
            (cp >= 0x0600 && cp <= 0x06ff) ||
            (cp >= 0x0750 && cp <= 0x077f) ||
            (cp >= 0xfb50 && cp <= 0xfdff) ||
            (cp >= 0xfe70 && cp <= 0xfeff)
        ) {
            tally.arabic++;
        } else if (cp >= 0x0900 && cp <= 0x097f) {
            tally.devanagari++;
        } else if (cp >= 0x0e00 && cp <= 0x0e7f) {
            tally.thai++;
        } else if (cp >= 0x3040 && cp <= 0x309f) {
            tally.hiragana++;
        } else if (cp >= 0x30a0 && cp <= 0x30ff) {
            tally.katakana++;
        } else if (cp >= 0xac00 && cp <= 0xd7af) {
            tally.hangul++;
        } else if (
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0x20000 && cp <= 0x2a6df)
        ) {
            tally.han++;
        } else {
            i += step;
            continue;
        }
        tally.total++;
        lettersSeen++;
        if (lettersSeen >= SAMPLE_LETTER_CAP && cappedEnd === text.length) {
            cappedEnd = i + step;
        }
        i += step;
    }
    return {
        tally,
        capped: cappedEnd === text.length ? text : text.slice(0, cappedEnd),
    };
}

/**
 * Decide a language from script ratios alone, when one script clearly
 * dominates AND maps cleanly to a single language. Returns `null`
 * when no rule fires (Latin / Cyrillic / Arabic / Devanagari / mixed
 * → defer to eld).
 *
 * Excluded on purpose:
 *   - Arabic script covers ar / fa / ur / ku — the caller's
 *     `languageFallback` (e.g. a Zotero `language: "fa"` field)
 *     would be ignored if we forced `"ar"` here.
 *   - Devanagari covers hi / mr / ne / sa — same reasoning.
 *   - Cyrillic covers ru / uk / bg / sr / be / ... — eld disambiguates.
 *   - Latin covers most European languages — eld disambiguates.
 */
function shortCircuitFromScripts(t: ScriptTally): string | null {
    if (t.total === 0) return null;
    const r = (n: number) => n / t.total;

    // CJK with kana → Japanese. Disambiguates ja vs zh within the CJK
    // family using the kana share *of CJK letters*, not of total
    // letters — academic Japanese PDFs routinely have ~30% Latin
    // abstracts which would dilute kana-of-total below any useful
    // threshold.
    const kana = t.hiragana + t.katakana;
    const cjk = t.han + kana;
    if (cjk > 0 && r(cjk) >= SCRIPT_DOMINANCE) {
        return kana / cjk >= KANA_SHARE_OF_CJK ? "ja" : "zh";
    }

    if (r(t.hangul) >= SCRIPT_DOMINANCE) return "ko";
    if (r(t.hebrew) >= SCRIPT_DOMINANCE) return "he";
    if (r(t.greek) >= SCRIPT_DOMINANCE) return "el";
    if (r(t.thai) >= SCRIPT_DOMINANCE) return "th";

    return null;
}

/**
 * Strip Latin letters (and the spaces / punctuation between them)
 * from `text` when a non-Latin disambiguation-script (Cyrillic /
 * Arabic / Devanagari) makes up at least `NON_LATIN_PRESENCE_FOR_STRIP`
 * of letters. This stops eld's input from being poisoned by an English
 * abstract on a Russian / Arabic / Hindi paper.
 *
 * Returns the original text unchanged when no script qualifies.
 */
function stripLatinIfNeeded(text: string, t: ScriptTally): string {
    if (t.total === 0) return text;
    const r = (n: number) => n / t.total;
    const targetSharePresent =
        r(t.cyrillic) >= NON_LATIN_PRESENCE_FOR_STRIP ||
        r(t.arabic) >= NON_LATIN_PRESENCE_FOR_STRIP ||
        r(t.devanagari) >= NON_LATIN_PRESENCE_FOR_STRIP;
    if (!targetSharePresent) return text;

    let out = "";
    for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i)!;
        const step = cp > 0xffff ? 2 : 1;
        const isLatinLetter =
            (cp >= 0x41 && cp <= 0x5a) ||
            (cp >= 0x61 && cp <= 0x7a) ||
            (cp >= 0xc0 && cp <= 0x024f) ||
            (cp >= 0x1e00 && cp <= 0x1eff);
        if (!isLatinLetter) out += text[i] + (step === 2 ? text[i + 1] : "");
        i += step;
    }
    return out;
}

function fallbackResult(opts: DetectOptions | undefined): DetectResult {
    if (opts?.fallback) {
        return {
            language: normalizeLanguageCode(opts.fallback),
            source: "fallback",
        };
    }
    return { language: "en", source: "default" };
}

export async function detectLanguageFromText(
    text: string,
    opts?: DetectOptions,
): Promise<DetectResult> {
    const minLetters = opts?.minLetters ?? DEFAULT_MIN_LETTERS;
    const { tally, capped } = tallyScripts(text ?? "");

    if (tally.total < minLetters) return fallbackResult(opts);

    const scriptHit = shortCircuitFromScripts(tally);
    if (scriptHit) return { language: scriptHit, source: "script" };

    // NFKC normalization collapses PDF-renderer glyph variants (Arabic
    // Presentation Forms-B at U+FE70..U+FEFF, fullwidth Latin, ligatures,
    // etc.) to their canonical base letters. eld's n-gram dictionary is
    // keyed on canonical letters; without this step, an Arabic PDF
    // rendered in presentation forms produces no match and eld returns
    // an empty string.
    const eldInput = stripLatinIfNeeded(capped, tally).normalize("NFKC");

    let raw: string;
    try {
        // webpackMode: "eager" — see file header for why.
        const mod: any = await import(
            /* webpackMode: "eager" */ "eld/extrasmall"
        );
        raw = mod.eld.detect(eldInput).language ?? "";
    } catch (err) {
        try {
            (globalThis as any).Zotero?.debug?.(
                `[Beaver][LanguageDetector] eld load/detect failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        } catch {
            // best effort
        }
        return fallbackResult(opts);
    }

    if (!raw || raw === "und") return fallbackResult(opts);

    const code = normalizeLanguageCode(raw);
    if (!SENTENCEX_ACCEPTED_DETECTED_LANGUAGES.has(code)) {
        return fallbackResult(opts);
    }
    return { language: code, source: "eld" };
}
