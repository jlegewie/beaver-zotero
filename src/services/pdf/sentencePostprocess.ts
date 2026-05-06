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
    context?: PostProcessContext,
) => SentenceRange[];

export interface PostProcessContext {
    /**
     * Optional source map parallel to `text`. Real PDF chars carry their source
     * line; synthetic fillers inserted between PDF lines carry `null`.
     */
    source?: ReadonlyArray<{ lineIndex: number; charIndex: number } | null>;
}

/**
 * Run the post-processing pipeline over splitter output.
 *
 * Empty input short-circuits. Each step receives the array produced by
 * the previous step.
 */
export function applyPostProcessing(
    ranges: ReadonlyArray<SentenceRange>,
    text: string,
    context?: PostProcessContext,
): SentenceRange[] {
    if (ranges.length === 0) return [];
    let current: SentenceRange[] = ranges as SentenceRange[];
    for (const step of POST_PROCESS_STEPS) {
        current = step(current, text, context);
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
// Step 3: split a trailing multi-segment numeric subsection label off the
// preceding range when the next range looks like a heading title
// ---------------------------------------------------------------------------

/**
 * Multi-segment numeric label at the end of a range, e.g. ` 4.1.` or ` 1.2.3.`.
 * Requires the leading whitespace boundary (so we never match a label that
 * isn't preceded by content) and at least two dot-separated segments. The
 * single-segment case (`We tried 4.`) is intentionally excluded because it
 * collides with normal prose ("version 4.", "Step 4.").
 */
const TRAILING_NUMERIC_SUBSECTION_RE = /\s\d+(?:\.\d+)+\.?$/;

/**
 * Heading-like continuation: short, no sentence-final punctuation, and at
 * least two reasonably long content words that are mostly Title-Cased.
 *
 * The Title-Case bias is what filters out `…value 1.5. The new release…`
 * style false positives — the next clause there is regular prose with at
 * most one capitalized word.
 */
function looksLikeHeadingContinuation(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 200) return false;
    const lastChar = trimmed[trimmed.length - 1];
    if (/[.!?]/.test(lastChar)) return false;
    const words = trimmed.split(/\s+/);
    if (words.length < 2) return false;
    const contentWords = words.filter((w) => w.length >= 4);
    if (contentWords.length < 2) return false;
    const capitalized = contentWords.filter((w) => /^\p{Lu}/u.test(w)).length;
    return capitalized >= contentWords.length * 0.5;
}

function nearestRealSourceBefore(
    source: NonNullable<PostProcessContext["source"]>,
    index: number,
): { lineIndex: number; charIndex: number } | null {
    for (let i = index - 1; i >= 0; i--) {
        const entry = source[i];
        if (entry) return entry;
    }
    return null;
}

function labelStartsOnSeparateLine(
    text: string,
    labelStart: number,
    context?: PostProcessContext,
): boolean {
    const source = context?.source;
    if (source) {
        const labelSource = source[labelStart];
        if (!labelSource) return false;

        const separatorSource = source[labelStart - 1];
        if (separatorSource !== null) return false;

        const previousSource = nearestRealSourceBefore(source, labelStart - 1);
        return (
            !!previousSource &&
            previousSource.lineIndex !== labelSource.lineIndex
        );
    }

    return text[labelStart - 1] === "\n" || text[labelStart - 1] === "\r";
}

/**
 * When two heading lines end up in the same paragraph (typical when
 * MuPDF strips font metadata so the paragraph detector can't separate
 * them) sentencex emits ranges like
 *   `"4. Discussion 4.1."`, `"Academic Performance in Pennsylvania Schools"`
 * and `mergeLabelSentences` doesn't fire because the first range isn't a
 * pure label. Split the trailing label off so the subsequent merge step
 * binds it to the heading title:
 *   `"4. Discussion"`, `"4.1."`, `"Academic Performance…"`
 *   ⇒ `"4. Discussion"`, `"4.1. Academic Performance…"`.
 *
 * Conservative guards keep this from firing on normal prose:
 *   - label must be multi-segment (`X.Y.` or longer)
 *   - next range must look like a heading continuation (Title-Cased,
 *     short, no terminal punctuation).
 */
export const splitTrailingNumericSubsectionLabel: PostProcessStep = (
    ranges,
    text,
    context,
) => {
    const out: SentenceRange[] = [];
    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const next = i + 1 < ranges.length ? ranges[i + 1] : null;
        const segText = text.slice(r.start, r.end);
        const m = TRAILING_NUMERIC_SUBSECTION_RE.exec(segText);
        if (
            !m ||
            !next ||
            !looksLikeHeadingContinuation(text.slice(next.start, next.end))
        ) {
            out.push(r);
            continue;
        }
        // m.index points at the leading whitespace; the label itself starts
        // one code unit later. Trim any whitespace off the prefix end.
        const labelStart = r.start + m.index + 1;
        if (!labelStartsOnSeparateLine(text, labelStart, context)) {
            out.push(r);
            continue;
        }
        let prefixEnd = labelStart;
        while (prefixEnd > r.start && /\s/.test(text[prefixEnd - 1]))
            prefixEnd--;
        if (prefixEnd > r.start) {
            out.push({ start: r.start, end: prefixEnd });
        }
        out.push({ start: labelStart, end: r.end });
    }
    return out;
};

// ---------------------------------------------------------------------------
// Step 4: collapse over-split bibliographic reference paragraphs
// ---------------------------------------------------------------------------

/**
 * Sentencex correctly splits at periods, but a single bibliographic reference
 * is *full* of periods that aren't sentence boundaries (author initials,
 * year + period, title + period, journal-info + period, trailing DOI). The
 * result is that one reference becomes 3–6 fragments, and a paragraph
 * containing several concatenated references (paragraph detector merges
 * across columns) is over-split into 10+ fragments.
 *
 * Goal: **one sentence ≈ one bibliographic reference**. Inline citations in
 * normal prose (`(Smith et al. 2023)`) must not be affected — the cost of a
 * false positive (collapsing real prose) is higher than the cost of leaving
 * a reference paragraph over-split.
 *
 * Strategy:
 *   1. Detect a reference paragraph using two independent shape signals
 *      that both must fire:
 *        A. The paragraph **starts** like a citation entry
 *           (numbered, "Surname, Initial(s)", "Initials. Surname",
 *            or "FirstName Surname" + nearby year).
 *        B. The paragraph carries strong bibliographic **tail** evidence
 *           (DOI/URL, Volume(Issue)+pages, Vol:Page, Pp., or a
 *            publisher/venue keyword in the trailing 120 chars).
 *   2. When classified as a reference paragraph, find boundary points
 *      between adjacent references — either `". " + reference-start` or
 *      `URL + " " + reference-start`. Re-split into N+1 sentences (one per
 *      reference) using the boundaries; the original sentencex splits inside
 *      a single reference are discarded.
 *   3. Sanity invariant: if the re-split would produce empty / out-of-order
 *      ranges or a sentence that doesn't start like a reference, fall back
 *      to the input ranges unchanged. Better to leave the existing over-split
 *      than to emit garbage.
 */

const REFERENCE_MIN_PARAGRAPH_LEN = 30;
const REFERENCE_TAIL_WINDOW_CHARS = 120;
const REFERENCE_A4_YEAR_WINDOW_CHARS = 80;

/**
 * Surname-token tail used in A2 and A4. Must start with a lowercase
 * letter (so all-caps tokens like `NJ` can't match an uppercase-then-
 * tail pattern), but the rest may include any letter to support
 * hyphenated compound surnames such as `Durán-Narucki`,
 * `Sainte-Beuve`, `Smith-Jones`. Apostrophe variants and explicit
 * hyphen are listed separately for clarity even though `\p{L}` covers
 * the alphabetic portion.
 */
const NAME_TAIL =
    "\\p{Ll}[\\p{L}\\u2019\\u2018\\u02BC'\\-]*";

/**
 * A1 — numbered list marker. `[12]`, `12.`, or `12)` followed by a
 * capitalized token. Limited to 1–3 digits so 4-digit year tokens
 * (`2008.`, `2017.`) inside reference text don't match as list markers.
 * Anchored variant prepends `^\s*`.
 */
const A1_CORE = `(?:\\[\\d{1,3}\\]|\\d{1,3}\\.|\\d{1,3}\\))\\s+\\p{Lu}`;

/**
 * A2 — "Surname, FirstName" or "Surname, Initial(s)". Allows R.J. (no
 * space between initials), R. J. (with), and "Athey, Susan, ..." (full
 * given name).
 */
const A2_CORE =
    `\\p{Lu}${NAME_TAIL},\\s*` +
    `(?:\\p{Lu}${NAME_TAIL}|\\p{Lu}\\.(?:\\s*\\p{Lu}\\.)*)`;

/**
 * A3 — "Initial(s) Surname" optionally with an "and Initial(s)" interlude.
 * Matches "S.K. Thompson", "T.M. and E.J. Atkinson".
 */
const A3_CORE =
    `(?:\\p{Lu}\\.\\s*){1,3}` +
    `(?:and\\s+(?:\\p{Lu}\\.\\s*){1,3})?` +
    `\\p{Lu}${NAME_TAIL}`;

/**
 * A4 — "FirstName Surname" followed by a comma or period. Used only as a
 * start-of-paragraph signal (NOT used for boundary detection because the
 * shape collides with normal prose mid-paragraph).
 */
const A4_CORE = `\\p{Lu}${NAME_TAIL}\\s+\\p{Lu}${NAME_TAIL}\\s*[\\.,]`;

const REF_START_AT_PARAGRAPH_RE = new RegExp(
    `^\\s*(?:${A1_CORE}|${A2_CORE}|${A3_CORE})`,
    "u",
);
const REF_A4_AT_PARAGRAPH_RE = new RegExp(`^\\s*${A4_CORE}`, "u");
const REF_YEAR_RE = /\b(?:19|20)\d{2}\b/u;
/**
 * Period-terminated reference boundary. `. ` followed by either A1
 * (numbered) or A2 (Surname, Initial/Name) reference-start.
 *
 * **A3 (Initials. Surname) is intentionally excluded here.** A3 matches
 * any `<Initial>. <Surname>` pattern, which collides with mid-reference
 * author initials like `1. B. F. C. Kafsack`: each internal `. F.` /
 * `. C.` boundary would then look like a reference start. A3-style
 * reference starts are still picked up via the URL-boundary path (they
 * never appear at a `. ` mid-paragraph except as part of an author
 * block in a previous reference, where they are already false matches).
 *
 * Capture group 1 is the reference-start prefix.
 *
 * Compiled **without** the `i` flag — under `iu`, JS treats `\p{Lu}` and
 * `\p{Ll}` as equivalent, which would let `[\p{Ll}…]+` match all-caps
 * tokens like `NJ` in `"Princeton, NJ: ..."` and produce false
 * boundaries. Boundary detection is strict-case.
 *
 * The negative lookbehind `(?<!\s\p{Lu})` excludes periods preceded by
 * a single-letter initial pattern. This prevents author-list internals
 * like `Michael G. Turner, Raymond` and `Atheendar S. Venkataramani,
 * David` from looking like reference boundaries (the `.` is a middle-
 * initial, not a sentence terminator). Real reference boundaries have
 * the `.` preceded by either a normal lowercase letter (`Press`,
 * `Companion`) or a digit (page numbers, years already excluded by the
 * `\d{1,3}` cap on A1).
 */
const REF_BOUNDARY_PERIOD_RE = new RegExp(
    `(?<!\\s\\p{Lu})\\.\\s+((?:${A1_CORE}|${A2_CORE}))`,
    "gu",
);

/**
 * URL-terminated reference boundary. URL or bare doi.org token followed
 * by whitespace + any of A1/A2/A3. URLs are unambiguous terminators so
 * the looser A3 form is safe here.
 */
const REF_BOUNDARY_URL_RE = new RegExp(
    `(?:\\bdoi\\.org\\/\\S+|\\bhttps?:\\/\\/\\S+)\\s+` +
        `((?:${A1_CORE}|${A2_CORE}|${A3_CORE}))`,
    "gu",
);

/**
 * Looser numbered-reference boundary used **only** when the paragraph
 * itself starts with a numbered list marker (A1-style). In that style,
 * references commonly do not end in a period — they end in a PMID,
 * URL, or other identifier — and the next reference starts simply at
 * `\s+ N. Capital`. Once we know the paragraph is a numbered reference
 * list, this boundary is safe (anything matching this shape inside is
 * almost certainly a reference start, not prose).
 *
 * The captured group 1 is the A1 reference-start prefix.
 */
const REF_BOUNDARY_NUMBERED_RE = new RegExp(`\\s+(${A1_CORE})`, "gu");

/** Detect whether the paragraph starts with a numbered list marker. */
const REF_NUMBERED_START_RE = new RegExp(`^\\s*${A1_CORE}`, "u");

/** B-pattern detectors (for the reference-tail check). */
// B1: a DOI or URL identifier. Three forms covered:
//   - canonical DOI URL: `https://doi.org/<...>` or bare `doi.org/<...>`
//   - CrossRef DOI prefix anywhere: `10.<4-9 digits>/<...>` (e.g.
//     `doi: 10.1038/nature12920` — common in Nature/Science references
//     where the DOI is written without `doi.org/`).
//   - generic `https?://` URL
const REF_TAIL_B1_RE =
    /(?:\bdoi\.org\/\S+|\bhttps?:\/\/\S{6,}|\b10\.\d{4,9}\/\S+)/iu;
const REF_TAIL_B2_RE = /\b\d{1,4}\(\d{1,3}\)\s*[:,]\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?/u;
// B3 — colon-separated journal-style citation. Requires a **page range**
// (hyphen-separated digits after the colon), so prose like
// `"Smith, J. argues that the relevant threshold is 12:34 ..."` does not
// produce a B-tail signal. Bare `Vol:Page` without a range is too easily
// confused with time-of-day, ratios, or score-style text.
const REF_TAIL_B3_RE = /\b\d{1,4}\s*:\s*\d{1,4}\s*[-–]\s*\d{1,4}\b/u;
const REF_TAIL_B4_RE = /\bpp?\.\s+\d{1,4}(?:\s*[-–]\s*\d{1,4})?\b/iu;
const REF_TAIL_B5_RE =
    /\b(?:Press|Publishers?|Publishing|Wiley|Springer|Elsevier|Routledge|Sage|Oxford|Cambridge|MIT|University Press|Working Paper|Technical Report|Retrieved\s+from)\b/iu;
// B6: PMID (PubMed ID). A strong reference-only signal — `pmid:` with a
// numeric ID appears almost exclusively in biomedical reference lists.
const REF_TAIL_B6_RE = /\bpmid:\s*\d{4,}/iu;

/**
 * Decide whether a paragraph starts like a bibliographic reference entry.
 * Pattern A — at least one of A1/A2/A3 must match the paragraph prefix,
 * or A4 must match alongside a year token within the first
 * `REFERENCE_A4_YEAR_WINDOW_CHARS` chars.
 *
 * @internal Exported for unit testing.
 */
export function hasReferenceStart(text: string): boolean {
    if (REF_START_AT_PARAGRAPH_RE.test(text)) return true;
    if (REF_A4_AT_PARAGRAPH_RE.test(text)) {
        const window = text.slice(0, REFERENCE_A4_YEAR_WINDOW_CHARS);
        if (REF_YEAR_RE.test(window)) return true;
    }
    return false;
}

/**
 * Decide whether a paragraph carries strong bibliographic-tail evidence.
 * Pattern B — at least one of B1..B5 must match. B5 is restricted to the
 * trailing window so a "Press" mention earlier in normal prose doesn't
 * count.
 *
 * @internal Exported for unit testing.
 */
export function hasReferenceTail(text: string): boolean {
    if (REF_TAIL_B1_RE.test(text)) return true;
    if (REF_TAIL_B2_RE.test(text)) return true;
    if (REF_TAIL_B3_RE.test(text)) return true;
    if (REF_TAIL_B4_RE.test(text)) return true;
    if (REF_TAIL_B6_RE.test(text)) return true;
    const tailStart = Math.max(0, text.length - REFERENCE_TAIL_WINDOW_CHARS);
    const tail = text.slice(tailStart);
    if (REF_TAIL_B5_RE.test(tail)) return true;
    return false;
}

/**
 * A∧B classifier: paragraph is reference-shaped iff it both starts and
 * ends like a bibliographic entry.
 *
 * @internal Exported for unit testing.
 */
export function isReferenceParagraph(text: string): boolean {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < REFERENCE_MIN_PARAGRAPH_LEN) return false;
    if (!hasReferenceStart(trimmed)) return false;
    if (!hasReferenceTail(trimmed)) return false;
    return true;
}

/**
 * Find boundary points between adjacent references in a paragraph.
 *
 * Returns offsets where each value is the trimmed start index of the
 * **next** reference (the first non-whitespace character of the next
 * reference's opening token). Boundaries come from two patterns:
 *   - `". " + reference-start` (normal period-terminated entry)
 *   - `URL + whitespace + reference-start` (URL-terminated entry)
 *
 * Offsets are returned sorted, deduplicated, and strictly ascending.
 *
 * @internal Exported for unit testing.
 */
export function findReferenceBoundaries(text: string): number[] {
    if (!text) return [];
    const offsets: number[] = [];

    const collect = (re: RegExp): void => {
        const r = new RegExp(re.source, re.flags);
        let m: RegExpExecArray | null;
        while ((m = r.exec(text)) !== null) {
            // Group 1 is the captured reference-start prefix. The
            // boundary offset is the first character of that capture.
            const captured = m[1] ?? "";
            if (!captured) {
                if (r.lastIndex <= m.index) r.lastIndex = m.index + 1;
                continue;
            }
            const start = m.index + (m[0].length - captured.length);
            if (start > m.index && start < text.length) {
                offsets.push(start);
            }
            // Advance past the start so the next iteration finds further
            // boundaries (without skipping overlapping starts).
            if (r.lastIndex <= start) r.lastIndex = start + 1;
        }
    };

    if (REF_NUMBERED_START_RE.test(text)) {
        // Numbered-style reference lists: use **only** the numbered
        // boundary (any `\s+ N. Capital`). The period-boundary form is
        // unsafe here because internal author-lists like
        // `R. L. Coppel, S. Lustigman, L. Murray, R. F. Anders, MESA`
        // contain repeated `<Surname>, <Initial>.` patterns that the
        // period-boundary regex (A2) would flag as new references.
        // The numbered boundary covers period-separated transitions
        // too (e.g. `(2014). 2. A. Sinha` — the `\s+` part matches the
        // space after `).`).
        collect(REF_BOUNDARY_NUMBERED_RE);
        collect(REF_BOUNDARY_URL_RE);
    } else {
        collect(REF_BOUNDARY_PERIOD_RE);
        collect(REF_BOUNDARY_URL_RE);
    }

    // Dedup + sort defensively (the regexes walk left-to-right but
    // `lastIndex` adjustment could in principle overlap, and the two
    // passes can match overlapping positions).
    offsets.sort((a, b) => a - b);
    const out: number[] = [];
    for (const o of offsets) {
        if (out.length === 0 || out[out.length - 1] !== o) out.push(o);
    }
    return out;
}

/**
 * For each boundary, find the trimmed end offset of the *previous*
 * reference range. The end is the first index after the previous
 * reference's terminating token (period for the `. ` boundary, last
 * URL char for the URL boundary). Trailing whitespace is dropped to
 * match the `splitOnEnumeratedListAfterColon` convention.
 */
function trimmedEndBeforeBoundary(text: string, boundary: number): number {
    let end = boundary;
    while (end > 0 && /\s/u.test(text[end - 1])) end--;
    return end;
}

/**
 * Sanity invariant for the merged sentence ranges produced by
 * `mergeReferenceListSentences`. Returns `true` when every range:
 *   1. is non-empty (`end > start`),
 *   2. is in strictly ascending order with the previous range
 *      (`r.start >= prev.end`),
 *   3. begins with a reference-start (A1/A2/A3 anchored to its
 *      own segment).
 *
 * If any check fails, the merge step falls back to the original
 * splitter ranges. This is defense-in-depth: the boundary regex
 * normally produces well-formed offsets, but a single bad
 * iteration is preferred to be a no-op rather than emit garbage.
 *
 * @internal Exported for unit testing.
 */
export function mergedRangesValid(
    newRanges: ReadonlyArray<SentenceRange>,
    text: string,
): boolean {
    for (let i = 0; i < newRanges.length; i++) {
        const r = newRanges[i];
        if (r.end <= r.start) return false;
        if (i > 0 && r.start < newRanges[i - 1].end) return false;
        const segment = text.slice(r.start, r.end);
        if (!hasReferenceStart(segment)) return false;
    }
    return true;
}

/**
 * Reference-collapse / re-split step. Runs after sentencex splits have
 * already been produced and the earlier post-processing steps have run.
 * Only modifies ranges when the paragraph is reference-shaped (A∧B);
 * otherwise returns the input unchanged.
 */
export const mergeReferenceListSentences: PostProcessStep = (ranges, text) => {
    if (ranges.length === 0) return ranges as SentenceRange[];
    if (!text) return ranges as SentenceRange[];
    if (!isReferenceParagraph(text)) return ranges as SentenceRange[];

    // Cover the trimmed paragraph extent.
    let trimStart = 0;
    while (trimStart < text.length && /\s/u.test(text[trimStart])) trimStart++;
    let trimEnd = text.length;
    while (trimEnd > trimStart && /\s/u.test(text[trimEnd - 1])) trimEnd--;
    if (trimEnd <= trimStart) return ranges as SentenceRange[];

    const boundaries = findReferenceBoundaries(text);
    // Filter boundaries to those inside the trimmed extent.
    const filtered = boundaries.filter(
        (b) => b > trimStart && b < trimEnd,
    );

    const newRanges: SentenceRange[] = [];
    let cursor = trimStart;
    for (const b of filtered) {
        const end = trimmedEndBeforeBoundary(text, b);
        if (end > cursor) {
            newRanges.push({ start: cursor, end });
        }
        cursor = b;
    }
    if (cursor < trimEnd) {
        newRanges.push({ start: cursor, end: trimEnd });
    }

    if (newRanges.length === 0) return ranges as SentenceRange[];

    // Sanity invariant: every emitted range must be non-empty, in
    // strictly ascending order, and start with a reference-start. If
    // any check fails, abort and return the original input — better to
    // leave the sentencex over-split than to emit garbage.
    if (!mergedRangesValid(newRanges, text)) return ranges as SentenceRange[];

    return newRanges;
};

// ---------------------------------------------------------------------------
// Pipeline registration
// ---------------------------------------------------------------------------

const POST_PROCESS_STEPS: ReadonlyArray<PostProcessStep> = [
    splitTrailingNumericSubsectionLabel,
    mergeLabelSentences,
    splitOnEnumeratedListAfterColon,
    mergeReferenceListSentences,
];
