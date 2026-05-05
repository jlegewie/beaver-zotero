/**
 * Post-processing pipeline for raw sentence ranges.
 *
 * Sits between the underlying splitter (sentencex-wasm or the regex
 * fallback) and downstream consumers (`SentenceMapper`,
 * `ParagraphSentenceMapper`). Its job is to clean up sentence boundaries
 * so the bboxes we build are citation-friendly.
 *
 * Steps are stacked in `POST_PROCESS_STEPS`. Each step has the same
 * shape (`PostProcessStep`) and runs in order. Adding a new behavior is
 * "write a function, append it to the array."
 *
 * The pipeline is invoked on the *paragraph-scoped* text that the
 * production splitter consumes (because `ParagraphSentenceMapper`
 * splits per paragraph). That means we never merge across paragraph
 * boundaries.
 */

import type { SentenceRange } from "./SentenceMapper";

// ---------------------------------------------------------------------------
// Pipeline composer
// ---------------------------------------------------------------------------

/**
 * A single post-processing step. Receives the current ranges and the
 * source text they index into, returns the new ranges. Must preserve
 * the half-open `[start, end)` convention and document order.
 */
export type PostProcessStep = (
    ranges: ReadonlyArray<SentenceRange>,
    text: string,
) => SentenceRange[];

/**
 * Run the post-processing pipeline over splitter output.
 *
 * Empty input short-circuits. Each step receives the array produced by
 * the previous step.
 */
export function applyPostProcessing(
    ranges: ReadonlyArray<SentenceRange>,
    text: string,
): SentenceRange[] {
    if (ranges.length === 0) return [];
    let current: SentenceRange[] = ranges as SentenceRange[];
    for (const step of POST_PROCESS_STEPS) {
        current = step(current, text);
    }
    return current;
}

// ---------------------------------------------------------------------------
// Step 1: merge label-only sentences with the following sentence
// ---------------------------------------------------------------------------

/**
 * Curated, deduped union of figure/table/section/etc. label words across
 * the languages we already normalize for in `normalizeLanguageCode`,
 * plus a few CJK / Arabic terms.
 *
 * Kept as a single union (no per-language switching) because Zotero's
 * `language` field is unreliable and the surrounding pattern
 * (`<keyword> <number>`) is restrictive enough that cross-language false
 * positives are unlikely.
 */
export const LABEL_KEYWORDS: ReadonlyArray<string> = Array.from(
    new Set([
        // English
        "Figure", "Fig", "Table", "Tab", "Section", "Sec",
        "Chapter", "Ch", "Equation", "Eq", "Appendix", "App",
        "Box", "Note", "Algorithm", "Alg",
        // German
        "Abbildung", "Abb", "Tabelle", "Kapitel", "Kap",
        "Gleichung", "Gl", "Abschnitt", "Abs", "Anhang", "Anh",
        "Algorithmus",
        // French
        "Tableau", "Chapitre", "Chap", "Équation", "Éq",
        "Annexe", "Ann", "Algorithme",
        // Spanish
        "Figura", "Tabla", "Capítulo", "Cap", "Ecuación", "Ec",
        "Sección", "Apéndice", "Ap", "Algoritmo",
        // Italian
        "Tabella", "Capitolo", "Equazione", "Sezione", "Appendice",
        // Portuguese
        "Tabela", "Equação", "Seção", "Secção", "Apêndice",
        // Dutch
        "Figuur", "Tabel", "Hoofdstuk", "Hfst", "Vergelijking", "Vgl",
        "Sectie", "Bijlage", "Bijl", "Algoritme",
        // Russian
        "Рисунок", "Рис", "Таблица", "Табл", "Глава", "Гл",
        "Раздел", "Уравнение", "Ур", "Приложение", "Прил", "Алгоритм",
        // Japanese
        "図", "表", "章", "節", "式", "付録",
        // Chinese (simplified + traditional)
        "图", "圖", "节", "節", "公式", "附录", "附錄",
        // Arabic
        "الشكل", "الجدول", "الفصل", "القسم", "المعادلة", "الملحق",
    ]),
);

/**
 * Maximum trimmed length for a range to be considered a "label."
 * Real labels (`Figure 1.`, `Abbildung 12.`, `3.1.`) are well under
 * this; the cap is a safety belt against the regex misfiring on a
 * pathological input.
 */
const LABEL_MAX_LEN = 40;

/**
 * Pure-numeric labels: `2.`, `3.1`, `3.1.`, `10.`, `1.1.1.`.
 * Anchored, no flags needed (digits are ASCII).
 */
const NUMERIC_LABEL_RE = /^\d+(?:\.\d+)*\.?$/;

/**
 * Labeled labels: `Figure 1.`, `Fig. 2`, `Table 3:`, `Abbildung 4.`.
 *
 * - `\.?` after the keyword tolerates both `Fig` and `Fig.`.
 * - `\s*` (zero-or-more whitespace) lets CJK forms like `图1` match
 *   without requiring a space.
 * - Trailing `[.:]?` covers `Figure 1.` and `Table 3:` styles.
 *
 * Compiled lazily so the keyword list can be appended in tests.
 */
let labelPatternCache: RegExp | null = null;
function getLabelPattern(): RegExp {
    if (labelPatternCache) return labelPatternCache;
    const escaped = LABEL_KEYWORDS.map((k) =>
        k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("|");
    labelPatternCache = new RegExp(
        `^(?:${escaped})\\.?\\s*\\d+(?:\\.\\d+)*[.:]?$`,
        "iu",
    );
    return labelPatternCache;
}

function isLabel(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > LABEL_MAX_LEN) return false;
    if (NUMERIC_LABEL_RE.test(trimmed)) return true;
    return getLabelPattern().test(trimmed);
}

/**
 * Merge ranges whose text is a label (e.g. `Figure 1.`, `2.`) with the
 * following range. The merged range spans `current.start` →
 * `next.end`, dropping the standalone label so the citation lands on
 * the following content.
 *
 * A label at the very end (no next range) is left alone — there's
 * nothing to merge into and dropping it would lose offsets.
 *
 * Two consecutive labels (rare, but possible: `Figure 1. Table 2. ...`)
 * collapse left-to-right: each label binds to whatever non-label range
 * eventually appears after it.
 */
export const mergeLabelSentences: PostProcessStep = (ranges, text) => {
    const out: SentenceRange[] = [];
    let pendingStart: number | null = null;

    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const segText = text.slice(r.start, r.end);
        const isLast = i === ranges.length - 1;

        if (!isLast && isLabel(segText)) {
            // Open a merge: remember the earliest start, keep walking.
            if (pendingStart === null) pendingStart = r.start;
            continue;
        }

        if (pendingStart !== null) {
            out.push({ start: pendingStart, end: r.end });
            pendingStart = null;
        } else {
            out.push(r);
        }
    }

    return out;
};

// ---------------------------------------------------------------------------
// Step 2: split enumerated lists introduced by a colon
// ---------------------------------------------------------------------------

/**
 * Pattern: colon, whitespace, parenthesized integer, whitespace, uppercase
 * letter. The `g` flag is added per-call so the regex object can be shared.
 *
 * `\p{Lu}` (Unicode uppercase letter) ensures we don't fire on inline lists
 * with lowercase items like `"...three: (1) the first, (2) the second..."`,
 * where keeping a single sentence is correct. The colon + parenthesized
 * integer + uppercase signal is the conventional academic-writing cue that
 * what follows is a sequence of full-sentence list items, e.g.
 * `"...women: (1) The NLSY97 consists..."` — sentencex splits after a
 * period before `(2)`, `(3)`, ... but not after the colon before `(1)`.
 */
const ENUMERATED_LIST_AFTER_COLON_RE = /:\s+\(\d+\)\s+\p{Lu}/u;

/**
 * Split a single sentence range at every `: (\d+) <uppercase>` occurrence.
 * The colon stays with the preceding clause; the new sub-range starts at
 * the opening paren of the enumerator. Whitespace between colon and paren
 * is dropped so neither sub-range carries trailing/leading filler.
 *
 * Applied after the splitter (sentencex or the regex fallback) has already
 * produced its boundaries — this fixes the one case where sentencex
 * doesn't break (`(1)` after a colon) while leaving paragraphs without the
 * pattern untouched.
 */
export const splitOnEnumeratedListAfterColon: PostProcessStep = (
    ranges,
    text,
) => {
    const out: SentenceRange[] = [];
    for (const range of ranges) {
        const segText = text.slice(range.start, range.end);
        const re = new RegExp(ENUMERATED_LIST_AFTER_COLON_RE.source, "gu");
        const splitPositions: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(segText)) !== null) {
            const parenIdx = segText.indexOf("(", m.index);
            if (parenIdx === -1) continue;
            splitPositions.push(parenIdx);
        }
        if (splitPositions.length === 0) {
            out.push(range);
            continue;
        }
        let cursor = 0;
        for (const splitAt of splitPositions) {
            // Trim the whitespace between the colon and the opening paren.
            let endIdx = splitAt;
            while (endIdx > cursor && /\s/.test(segText[endIdx - 1])) endIdx--;
            if (endIdx > cursor) {
                out.push({
                    start: range.start + cursor,
                    end: range.start + endIdx,
                });
            }
            cursor = splitAt;
        }
        if (cursor < segText.length) {
            out.push({ start: range.start + cursor, end: range.end });
        }
    }
    return out;
};

// ---------------------------------------------------------------------------
// Pipeline registration
// ---------------------------------------------------------------------------

const POST_PROCESS_STEPS: ReadonlyArray<PostProcessStep> = [
    mergeLabelSentences,
    splitOnEnumeratedListAfterColon,
];
