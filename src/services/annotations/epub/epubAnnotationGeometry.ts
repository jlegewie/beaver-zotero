/**
 * EPUB annotation position + sortIndex helpers.
 *
 * The Zotero reader stores an EPUB annotation's location as a Web Annotation
 * `FragmentSelector` whose value is an epubcfi, and a `sortIndex` of the form
 * `SSSSS|OOOOOOOO` (5-digit spine section index, 8-digit character offset from
 * the section start). Zotero core enforces the sortIndex format for EPUB
 * attachments (`^\d{5}\|\d{8}$`); the position itself is opaque JSON.
 */

/** EPUB CFI FragmentSelector, per the Web Annotation Data Model. */
export interface EpubFragmentSelector {
    type: "FragmentSelector";
    conformsTo: string;
    value: string;
}

/** `conformsTo` URI the reader uses for EPUB CFI fragment selectors. */
export const EPUB_CFI_CONFORMS_TO =
    "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";

const SORT_INDEX_SECTION_MAX = 99999; // 5 digits
const SORT_INDEX_OFFSET_MAX = 99999999; // 8 digits

/** Coerce to a non-negative integer in [0, max]; NaN/negatives/Infinity → 0. */
function clampNonNegativeInt(value: unknown, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    const floored = Math.floor(value);
    if (floored <= 0) return 0;
    return floored > max ? max : floored;
}

/**
 * Build a Zotero EPUB annotation sort index in the canonical `section|offset`
 * format (`^\d{5}\|\d{8}$`, enforced by chrome/content/zotero/xpcom/data/
 * item.js for EPUB attachments).
 *
 * - `rawSectionIndex` is the **raw spine itemref index** (counting every
 *   `<itemref>`), matching the reader's `data-section-index`. This is not the
 *   extractor's compacted section index, which can drift on mixed-media EPUBs.
 * - `charOffset` is the character count from the section start to the
 *   annotation start, on the same scale as the reader's `getSortIndex` so
 *   Beaver annotations interleave with manually created ones in the sidebar.
 */
export function buildEpubSortIndex(rawSectionIndex: number, charOffset: number): string {
    const section = clampNonNegativeInt(rawSectionIndex, SORT_INDEX_SECTION_MAX);
    const offset = clampNonNegativeInt(charOffset, SORT_INDEX_OFFSET_MAX);
    return [
        section.toString().padStart(5, "0"),
        offset.toString().padStart(8, "0"),
    ].join("|");
}

/** Wrap an epubcfi string as a Zotero EPUB annotation position. */
export function toEpubFragmentSelector(cfiString: string): EpubFragmentSelector {
    return {
        type: "FragmentSelector",
        conformsTo: EPUB_CFI_CONFORMS_TO,
        value: cfiString,
    };
}
