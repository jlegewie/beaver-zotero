/**
 * Printed page labels: the page numbers printed on a document's pages.
 *
 * A PDF carries up to two label sources. Its own `/PageLabels` (the *embedded*
 * labels) are often missing or meaningless, e.g. `1..N` on an article printed
 * as pp. 1201-1220. *Derived* labels are read from the page margins during
 * full structured extraction and match the printed page far more often.
 *
 * `resolvePrintedPageLabels` is the single definition of "the printed label of
 * page i". Everything Beaver shows a person or the model as a page number goes
 * through it. Labels written into Zotero (note-citation locators, annotation
 * labels) come from `resolveZoteroLocatorPageLabels`: the printed labels, or
 * the embedded ones for a document without printed labels.
 */

/** Label sources for one document. Maps are keyed by 0-based page index. */
export interface PageLabelSources {
    /** Page count; labels past it are dropped. `null` when unknown. */
    pageCount: number | null;
    /** Labels derived from the printed page numbers (`derivedPageLabels`). */
    derived?: Record<string, string> | null;
    /**
     * The PDF's own `/PageLabels`. Not used for printed labels: they add
     * spurious labels on covers and download sheets without improving recall.
     * Zotero locator labels use them for documents without printed labels.
     */
    embedded?: Record<string, string> | Record<number, string> | null;
}

/** Printed label per 0-based page index; pages without one are absent. */
export function resolvePrintedPageLabels(src: PageLabelSources): Record<number, string> {
    const out: Record<number, string> = {};
    if (!src.derived) return out;
    for (const [key, value] of Object.entries(src.derived)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0) continue;
        if (src.pageCount != null && index >= src.pageCount) continue;
        if (typeof value === 'string' && value.trim()) out[index] = value;
    }
    return out;
}

/**
 * Labels Beaver writes into Zotero (note-citation locators), per 0-based page
 * index. The source is chosen per document, never mixed per page: the printed
 * labels when the document has any, else the embedded labels. A page the
 * chosen source does not label is absent; callers leave it out of a citation
 * (`citationPageLocator`), or use the physical page when the document has no
 * labels at all.
 *
 * Mixing per page would label an unnumbered cover with the PDF's "1" next to
 * printed "813" (and embedded labels are mostly wrong where printed ones
 * exist). Zotero navigates a note citation by exact match of its locator
 * against the reader's labels; on a PDF whose embedded labels are wrong,
 * Zotero 11 navigates by those, so a printed locator can land on another page
 * there. That is accepted: the locator is also the page the citation prints in
 * a manuscript, and writing `/PageLabels` into the PDF is the fix for the click.
 */
export function resolveZoteroLocatorPageLabels(src: PageLabelSources): Record<number, string> {
    const printed = resolvePrintedPageLabels(src);
    if (Object.keys(printed).length > 0) return printed;
    const out: Record<number, string> = {};
    for (const [key, value] of Object.entries(src.embedded ?? {})) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0) continue;
        if (src.pageCount != null && index >= src.pageCount) continue;
        if (typeof value === 'string' && value.trim()) out[index] = value;
    }
    return out;
}

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** The value of a Roman numeral label (`xiv` → 14), or null. */
function romanValue(label: string): number | null {
    const lower = label.toLowerCase();
    if (!/^[ivxlcdm]+$/.test(lower)) return null;
    let total = 0;
    for (let i = 0; i < lower.length; i++) {
        const value = ROMAN_VALUES[lower[i]];
        const next = ROMAN_VALUES[lower[i + 1]] ?? 0;
        total += value < next ? -value : value;
    }
    return total > 0 ? total : null;
}

/**
 * The value of an alphabetic label as PDF page labels count them (`A`…`Z`,
 * then `AA`…`ZZ`, `AAA`…; same for lowercase), or null.
 */
function alphabeticValue(label: string): number | null {
    if (!/^([A-Za-z])\1*$/.test(label)) return null;
    return (label.length - 1) * 26 + (label[0].toLowerCase().charCodeAt(0) - 96);
}

/** Whether a label belongs to a numbering `labelsSpanPages` can follow. */
function isRecognizedNumbering(label: string): boolean {
    label = label.trim();
    return /\d$/.test(label) || romanValue(label) !== null || alphabeticValue(label) !== null;
}

/**
 * Whether labels `a` and `b` are `distance` apart in one numbering sequence:
 * numbers with the same prefix (`12`→`14`, `S12`→`S14`, `A-3`→`A-5`), Roman
 * numerals (`iv`→`vi`), or letters of one case (`A`→`C`, `Z`→`AA`).
 */
export function labelsSpanPages(a: string | undefined, b: string | undefined, distance: number): boolean {
    a = a?.trim();
    b = b?.trim();
    if (!a || !b) return false;
    const numberedA = /^(.*?)(\d+)$/.exec(a);
    const numberedB = /^(.*?)(\d+)$/.exec(b);
    if (numberedA || numberedB) {
        return !!numberedA && !!numberedB
            && numberedA[1] === numberedB[1]
            && Number(numberedB[2]) - Number(numberedA[2]) === distance;
    }
    const romanA = romanValue(a);
    const romanB = romanValue(b);
    if (romanA !== null && romanB !== null && romanB - romanA === distance) return true;
    const letterA = alphabeticValue(a);
    const letterB = alphabeticValue(b);
    return letterA !== null && letterB !== null
        && (a[0] === a[0].toUpperCase()) === (b[0] === b[0].toUpperCase())
        && letterB - letterA === distance;
}

/**
 * Whether labels `a` and `b`, `distance` pages apart, show a change of
 * numbering: they do not follow each other (`labelsSpanPages`) and at least
 * one belongs to a numbering that could be followed (a cover's `1` before
 * printed `813`; `iv` before `1`). Two labels of an unrecognized style are not
 * a change, so a range in such labels is kept whole.
 */
export function labelsBreakNumbering(a: string, b: string, distance: number): boolean {
    if (labelsSpanPages(a, b, distance)) return false;
    return isRecognizedNumbering(a) || isRecognizedNumbering(b);
}
