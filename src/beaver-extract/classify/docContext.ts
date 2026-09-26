/**
 * Document-level context for item classification.
 *
 * The accumulator is deliberately tiny and serializable: three counters
 * that summarize everything seen earlier in reading order. It is threaded
 * through the multi-page structured path page by page, and degrades to a
 * neutral "nothing seen yet" value on single-page debug paths, where the
 * document-context features simply read as zero.
 *
 * Pure and dependency-free so it stays legal inside the MuPDF worker.
 */

export interface DocContext {
    /** Items seen on pages processed before the current one. */
    itemCount: number;
    /** Of those, how many looked like bibliographic reference entries. */
    referenceLikeCount: number;
    /**
     * Whether a reference-section header ("References", "Bibliography", …)
     * has already appeared in reading order. Sticky once set: a long
     * bibliography spans many pages and only the first carries the header.
     */
    referenceHeaderSeen: boolean;
}

/** Per-page summary folded into a {@link DocContext}. */
export interface DocContextDelta {
    itemCount: number;
    referenceLikeCount: number;
    referenceHeaderSeen: boolean;
}

/** Neutral starting context — no pages seen yet. */
export function createDocContext(): DocContext {
    return { itemCount: 0, referenceLikeCount: 0, referenceHeaderSeen: false };
}

/** Fold one page's summary into the running context. Returns a new object. */
export function updateDocContext(
    context: DocContext,
    delta: DocContextDelta,
): DocContext {
    return {
        itemCount: context.itemCount + Math.max(0, delta.itemCount),
        referenceLikeCount:
            context.referenceLikeCount + Math.max(0, delta.referenceLikeCount),
        referenceHeaderSeen:
            context.referenceHeaderSeen || delta.referenceHeaderSeen,
    };
}

/**
 * Longest plausible reference-section heading. Headings are short; a long
 * paragraph that happens to open with "References" is prose about
 * references, not the heading of a bibliography.
 */
const MAX_HEADER_LENGTH = 60;

/**
 * Leading outline numbering / markdown prefix a heading may carry:
 * "5.", "IV.", "A.", "## ", "Appendix" enumerators and similar.
 */
const HEADER_PREFIX_RE =
    /^[\s#*•·\-–—]*(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.|[a-z]\.)?[\s.)\]]*/i;

/**
 * Reference-section heading vocabulary, English plus the most common
 * German / French / Spanish / Italian / Portuguese forms found in the
 * corpus. Matched against the normalized heading text (lowercased,
 * numbering and trailing punctuation stripped), so the alternatives
 * only have to cover the bare words.
 *
 * Split by ambiguity. The unambiguous forms name a bibliography and
 * nothing else, so any short item may carry them — the paragraph
 * detector misses some real "References" headings, and those still need
 * to count. The ambiguous forms ("Notes", "Sources", "Literature", the
 * singular "Reference", …) also label table notes, table column headers,
 * source lines under figures and prose headings, so they only count on
 * items the detector already classified as a heading.
 */
const UNAMBIGUOUS_HEADER_RE = new RegExp(
    "^(?:" +
        [
            "references(?:\\s+(?:and|&)\\s+notes?)?(?:\\s+cited)?",
            "reference\\s+list",
            "list\\s+of\\s+references",
            "bibliography",
            "select(?:ed)?\\s+bibliography",
            "works\\s+cited",
            "literature\\s+cited",
            "cited\\s+literature",
            "endnotes",
            "bibliographie",
            "literaturverzeichnis",
            "quellenverzeichnis",
            "r[ée]f[ée]rences(?:\\s+bibliographiques)?",
            "bibliograf[ií]a",
            "referencias(?:\\s+bibliogr[áa]ficas)?",
            "riferimenti(?:\\s+bibliografici)?",
            "refer[êe]ncias(?:\\s+bibliogr[áa]ficas)?",
        ].join("|") +
        ")$",
    "i",
);

const AMBIGUOUS_HEADER_RE = new RegExp(
    "^(?:" +
        [
            "reference",
            "notes(?:\\s+(?:and|&)\\s+references?)?",
            "sources",
            "literature",
            "literatur",
            "quellen",
        ].join("|") +
        ")$",
    "i",
);

/**
 * Decide whether an item's text is a reference-section heading.
 *
 * Case-insensitive and tolerant of outline numbering, markdown hashes and
 * trailing punctuation, but bounded by {@link MAX_HEADER_LENGTH} so body
 * prose cannot trip it. Pass `isHeading` when the paragraph detector
 * classified the item as a heading; the ambiguous vocabulary ("Notes",
 * "Sources", …) is only accepted for such items.
 */
export function looksLikeReferenceHeader(
    text: string,
    options: { isHeading?: boolean } = {},
): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_HEADER_LENGTH) return false;
    const normalized = trimmed
        .replace(HEADER_PREFIX_RE, "")
        .replace(/[\s.:;*_)\]]+$/u, "")
        .trim();
    if (normalized.length === 0) return false;
    if (UNAMBIGUOUS_HEADER_RE.test(normalized)) return true;
    return options.isHeading === true && AMBIGUOUS_HEADER_RE.test(normalized);
}
