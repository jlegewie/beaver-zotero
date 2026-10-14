/**
 * Derived page labels: the page numbers a PDF prints in its margins.
 *
 * `pageNumberObservations` (in `MarginFilter`) reports the margin numerals
 * that may be page numbers, and
 * `pageEdgeRowObservations` adds those of each page's top and bottom text
 * rows, which can sit outside the margin zones. A printed page number
 * advances in lockstep with the page index, so `value - pageIndex` is
 * constant across a run of numbered pages. This module groups the
 * observations into such runs, keeps one numbering per page, and labels the
 * pages each run spans, including unnumbered pages inside it (an article's
 * first page, full-page figures).
 *
 * The result is independent of the PDF's own `/PageLabels` (catalog labels):
 * it reports what the pages print, not what the file declares.
 *
 * Worker-safe: depends only on agent-core types, `MarginFilter` and
 * `PageRotationNormalizer`.
 */

import {
    DEFAULT_MARGIN_ZONE,
    type BoundingBox,
    type MarginPosition,
    type MarginSettings,
    type RawLine,
    type RawPageData,
} from "@beaver/agent-core/extract/types";
import {
    detectDominantTextOrientation,
    inverseRotateBBox,
    rotateRawPage,
} from "./PageRotationNormalizer";
import {
    containsBox,
    distinctPlaces,
    emOf,
    isFootnoteMarker,
    isPageCounter,
    isScatteredRow,
    normalizeDigits,
    parseCounter,
    parseDashWrapped,
    parsePrintedPageNumber,
    rowEndBoxes,
    rowEndWords,
    rowPageNumberWords,
    SCATTERED_MIN_CHARACTERS,
    SCATTERED_PLACE,
    spacedRowNumber,
    unionBBox,
} from "./MarginFilter";

/** A numeral at the edge of a page that may be its printed page number. */
export interface PageNumberObservation {
    pageIndex: number;
    /** Parsed value: the page number the element prints. */
    value: number;
    /** Text as printed ("12", "Page 12", "xiv"). */
    text: string;
    /** A bare Roman numeral ("xiv", "IV") rather than an Arabic number. */
    roman: boolean;
    /**
     * Printed text before the number of a prefixed folio ("S" of "S12",
     * "014105-" of "014105-3"), part of the page's label.
     */
    prefix?: string;
    position: MarginPosition;
    /**
     * Read from a header or footer line that margin detection did not remove
     * as a page number (its first or last word, as in "644 R. Allen and A.
     * Vignoles"), or from a page's top or bottom text rows. Weaker evidence
     * than a removed page number.
     */
    edge?: boolean;
    /** Read from letter-spaced digits ("3 8" for 38). */
    spaced?: boolean;
    /**
     * Font size of the text the number was read from, the same whichever
     * way the page is turned (unlike `bbox`'s height).
     */
    em?: number;
    /**
     * An Arabic number, no larger than the page's position, opening a top or
     * bottom row whose other text no other page prints at its edges ("2
     * Methods"): a numbered heading's row rather than a running head's.
     */
    headingRow?: boolean;
    /**
     * Box of the element, line or row the number was read from, in MuPDF's
     * page frame. A word of a longer line has the whole line's box.
     */
    bbox?: BoundingBox;
    /**
     * How often the page prints `text` in this zone, when more than once (a
     * page number beside an equal fixed numeral).
     */
    occurrences?: number;
}

/** Minimum numbered pages a run needs to be trusted. */
const MIN_RUN_PAGES = 3;

/**
 * Largest step between consecutive numbered pages of one run. Numerals that
 * happen to match an offset far apart are not a run, and the pages between
 * them must not be filled.
 */
const MAX_RUN_GAP = 6;

/**
 * A two-page run is accepted when it is all the evidence a short document
 * can offer: at most this many pages long.
 */
const SHORT_DOCUMENT_PAGES = 4;

/**
 * Pages a run's labels extend past its first and last numbered page, when
 * those pages carry no numbering of their own. Covers the unnumbered opening
 * page of an article and a closing page without a footer.
 */
const RUN_EXTENSION_PAGES = 1;

/**
 * A run extends further back, up to this many pages, when that reaches page
 * 1: a book's main text often starts with an unnumbered part title and
 * chapter opener before the first printed number.
 */
const FIRST_PAGE_EXTENSION_PAGES = 3;

interface Run {
    /** Script, prefix and offset, shared by every run of one numbering. */
    key: string;
    roman: boolean;
    /** Printed text before each number ("S" of "S12"); empty for most. */
    prefix: string;
    /** Digits each number is zero-padded to ("07"), or 0. */
    padding: number;
    /** Median font size of the numbering's folios, when known. */
    folioEm?: number;
    /** `value - pageIndex` for every page of the run. */
    offset: number;
    /** Numbered pages, ascending. */
    pages: number[];
    /**
     * Evidence for the run: a page whose number margin detection removed
     * counts twice, a page seen only in an edge word or row once.
     */
    weight: number;
    upperCase: boolean;
    /** The run's last page says it is the last ("12 of 12"). */
    endsDocument: boolean;
}

/**
 * Page labels derived from printed page numbers, keyed by 0-based page
 * index. Pages without a trusted numbering are absent.
 */
export function derivePageLabels(
    observations: readonly PageNumberObservation[],
    pageCount: number,
    pageSizes?: readonly (PageSize | undefined)[],
): Record<number, string> {
    const { runs, numberedPages, folioNumbers, lastPages } = candidateRuns(observations, pageCount);
    const accepted = selectRuns(runs);
    // A page that prints a number of another numbering is not unnumbered,
    // even when that numbering is too short to be a run of its own, nor one
    // that prints a number just off the run's (`printsShiftedNumber`). A
    // numbering printed on the run's own pages as well (a "Page 3 of 6"
    // counter beside the journal's folios) runs alongside it and doesn't
    // count. Nor is a sheet whose size matches none of the run's numbered
    // pages next to it (`neighbors`): a cover or notice a repository added
    // to the work is not one of its printed pages.
    const alongside = new Map(accepted.map((run) => [run, parallelKeys(run, numberedPages)]));
    const claimable = (pageIndex: number, run: Run, neighbors: readonly number[]) =>
        pageIndex >= 0
        && pageIndex < pageCount
        && !owner.has(pageIndex)
        && [...(numberedPages.get(pageIndex) ?? [])].every((key) =>
            key === run.key || alongside.get(run)!.has(key))
        && !printsShiftedNumber(folioNumbers.get(pageIndex), run, pageIndex)
        && neighbors.some((p) => sameSheetSize(pageSizes?.[pageIndex], pageSizes?.[p]));

    // A run labels every page it spans. Its numbered pages on both sides
    // outweigh a stray number on a gap page (an OCR misread, a fraction, a
    // footnote's "p. 351"); an inserted page with its own numbering shifts
    // the offset on the far side and so splits the run instead.
    const owner = new Map<number, Run>();
    for (const run of accepted) {
        const first = run.pages[0];
        const last = run.pages[run.pages.length - 1];
        for (let p = first; p <= last; p++) owner.set(p, run);
    }
    // Extend each run into the unclaimed pages next to it: backwards first,
    // since a numbering's unnumbered opening pages belong to it rather than
    // to the trailing pages of the numbering before.
    for (const run of accepted) {
        const first = run.pages[0];
        const firstValue = first + run.offset;
        const reach = firstValue - 1 <= FIRST_PAGE_EXTENSION_PAGES
            ? Math.max(RUN_EXTENSION_PAGES, firstValue - 1)
            : RUN_EXTENSION_PAGES;
        for (let k = 1; k <= reach; k++) {
            const before = first - k;
            // A page before page 1 is not this numbering's; leave it free
            // for the numbering before (front matter's last page).
            if (before + run.offset < 1 || !claimable(before, run, run.pages.slice(0, SIZE_NEIGHBORS))) break;
            owner.set(before, run);
        }
    }
    for (const run of accepted) {
        const last = run.pages[run.pages.length - 1];
        // A run whose last page prints "N of N", in its own numbering or one
        // alongside it ("Page 3 of 3" beside folio 103), ends the document's
        // pages; a sheet after it is appended.
        if (run.endsDocument || [...alongside.get(run)!].some((key) => lastPages.get(key)?.has(last))) continue;
        for (let k = 1; k <= RUN_EXTENSION_PAGES; k++) {
            const after = last + k;
            if (!claimable(after, run, run.pages.slice(-SIZE_NEIGHBORS))) break;
            owner.set(after, run);
        }
    }

    const labels: Record<number, string> = {};
    for (const [pageIndex, run] of owner) {
        const value = pageIndex + run.offset;
        if (value < 1) continue;
        const label = run.roman
            ? toRoman(value, run.upperCase)
            : run.prefix + String(value).padStart(run.padding, "0");
        if (label) labels[pageIndex] = label;
    }
    return labels;
}

/**
 * Numberings other than `run`'s printed on at least half of its numbered
 * pages: a parallel numbering of the same pages, not a separate one.
 */
function parallelKeys(run: Run, numberedPages: ReadonlyMap<number, ReadonlySet<string>>): Set<string> {
    const counts = new Map<string, number>();
    for (const page of run.pages) {
        for (const key of numberedPages.get(page) ?? []) {
            if (key !== run.key) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return new Set([...counts].filter(([, n]) => n * 2 >= run.pages.length).map(([key]) => key));
}

/** A page's width and height, in points. */
export interface PageSize {
    width: number;
    height: number;
}

/**
 * Largest relative difference between the sides of two pages of one
 * printed sequence. Scans of one book vary by a few percent; a repository's
 * cover sheet (A4 or Letter before a book-sized article) differs more.
 */
const SHEET_SIZE_TOLERANCE = 0.03;

/**
 * Numbered pages at a run's end a page it extends to is compared with: the
 * pages of a scanned book differ in size among themselves.
 */
const SIZE_NEIGHBORS = 3;

/**
 * Whether two pages have the same size, either way up (a table turned
 * sideways is still a page of the work). Unknown sizes count as the same.
 */
function sameSheetSize(a: PageSize | undefined, b: PageSize | undefined): boolean {
    if (!a || !b) return true;
    const [aShort, aLong] = [Math.min(a.width, a.height), Math.max(a.width, a.height)];
    const [bShort, bLong] = [Math.min(b.width, b.height), Math.max(b.width, b.height)];
    const close = (x: number, y: number) => Math.abs(x - y) <= SHEET_SIZE_TOLERANCE * Math.max(x, y);
    return close(aShort, bShort) && close(aLong, bLong);
}

/**
 * `observations` with every reading of a numbered heading's number marked
 * `headingRow`: margin detection reads the number of a heading inside its
 * zone as well, without the edge rows' view of the whole document. A
 * reading counts as the heading's when it is the same number on the same
 * line (its box overlaps the heading's vertically); a folio printed in
 * another row of the page keeps counting.
 */
function withHeadingRows(observations: readonly PageNumberObservation[]): readonly PageNumberObservation[] {
    const headings = observations.filter((obs) => obs.headingRow && !obs.roman && obs.bbox);
    if (headings.length === 0) return observations;
    const onHeadingLine = (obs: PageNumberObservation) => headings.some((heading) =>
        heading.pageIndex === obs.pageIndex
        && heading.position === obs.position
        && heading.value === obs.value
        && sameLine(heading.bbox!, obs.bbox!));
    return observations.map((obs) =>
        !obs.headingRow && !obs.roman && obs.bbox && onHeadingLine(obs) ? { ...obs, headingRow: true } : obs);
}

/** Whether two boxes share a line: they overlap vertically by half the lower one's height. */
function sameLine(a: BoundingBox, b: BoundingBox): boolean {
    const [aTop, aBottom] = [Math.min(a.t, a.b), Math.max(a.t, a.b)];
    const [bTop, bBottom] = [Math.min(b.t, b.b), Math.max(b.t, b.b)];
    const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
    return overlap > 0 && overlap * 2 >= Math.min(aBottom - aTop, bBottom - bTop);
}

/**
 * Observations without the single digits of a letter-spaced number: "3 8"
 * also yields "3" and "8" alone, and its last digit steps with the page
 * index until it wraps. A digit is one of the number's own pieces when its
 * box lies inside the spaced number's box; digits without a box are kept.
 */
function withoutSpacedDigits(
    observations: readonly PageNumberObservation[],
): PageNumberObservation[] {
    const spacedByPage = new Map<number, BoundingBox[]>();
    for (const obs of observations) {
        if (!obs.spaced || !obs.bbox) continue;
        let boxes = spacedByPage.get(obs.pageIndex);
        if (!boxes) {
            boxes = [];
            spacedByPage.set(obs.pageIndex, boxes);
        }
        boxes.push(obs.bbox);
    }
    if (spacedByPage.size === 0) return [...observations];
    return observations.filter((obs) => {
        if (obs.roman || obs.spaced || !obs.bbox || String(obs.value).length !== 1) return true;
        return !(spacedByPage.get(obs.pageIndex) ?? []).some((row) => containsBox(row, obs.bbox!));
    });
}

/** Whether an observation prints its page as the document's last ("8 of 8"). */
function printsLastPage(obs: PageNumberObservation): boolean {
    const counter = parseCounter(obs.text);
    return !!counter && counter.page === obs.value && counter.total === obs.value;
}

/**
 * Observations without page furniture: a numeral printed at the same
 * position on an adjacent page as well (a publisher logo's digits, a
 * footer's fixed numbers). A page number never repeats on the next page, and
 * furniture paired with its neighbors would otherwise step with the page
 * index by chance. A numbering that restarts (a compiled thesis numbering
 * each part from 1) repeats its numerals only on pages far apart, so it
 * stays.
 *
 * In a short document, a page that prints the numeral more often than its
 * neighbors (a page number beside an equal fixed numeral: page 16 of volume
 * 16) keeps it, since its run has no pages to spare. A longer run fills such
 * a page from its neighbors, and counting there would revive numerals that
 * repeat within a page (a contents entry and its page reference).
 */
function withoutFurniture(
    observations: readonly PageNumberObservation[],
    pageCount: number,
): PageNumberObservation[] {
    const counted = pageCount <= SHORT_DOCUMENT_PAGES;
    // Keyed by printed text: "8 of 8" on a last page is not the "8" every
    // footer repeats as the page count.
    const numeral = (obs: PageNumberObservation, pageIndex: number) =>
        `${pageIndex}\u0000${obs.position}\u0000${obs.text.trim()}`;
    // Observations from margin detection and from edge rows read the same
    // numerals, so a page's count is the larger of the two.
    const counts = new Map<string, number>();
    for (const obs of observations) {
        const key = numeral(obs, obs.pageIndex);
        counts.set(key, Math.max(counts.get(key) ?? 0, counted ? obs.occurrences ?? 1 : 1));
    }
    // Text and zone only, not location: footers that alternate sides on
    // facing pages print their fixed numerals at mirrored positions.
    return observations.filter((obs) => {
        const own = counts.get(numeral(obs, obs.pageIndex))!;
        return (counts.get(numeral(obs, obs.pageIndex - 1)) ?? 0) < own
            && (counts.get(numeral(obs, obs.pageIndex + 1)) ?? 0) < own;
    });
}

/**
 * Observations grouped by script and offset into runs worth considering,
 * and the numberings each page prints: the keys of groups in which the page
 * has a neighbor within `MAX_RUN_GAP`. A numeral alone in its group (a year,
 * a chapter number) is noise and claims nothing, unless it names itself a
 * page number ("Page 1", see `isPageCounter`).
 */
function candidateRuns(
    allObservations: readonly PageNumberObservation[],
    pageCount: number,
): { runs: Run[]; numberedPages: Map<number, Set<string>>; folioNumbers: Map<number, PageNumberObservation[]>; lastPages: Map<string, Set<number>> } {
    const observations = withoutFurniture(withoutSpacedDigits(withHeadingRows(allObservations)), pageCount);
    // Numbers a page prints as its folio, for `printsShiftedNumber`: those
    // margin detection removed, and prefixed ("S5") and dash-wrapped
    // ("- 5 -") folios, which are only read from header and footer rows.
    // Other numbers of those rows are not evidence enough: a contents page's
    // entries end its rows too.
    const folioNumbers = new Map<number, PageNumberObservation[]>();
    for (const obs of observations) {
        if (obs.edge && !obs.prefix && parseDashWrapped(obs.text) === null) continue;
        const folios = folioNumbers.get(obs.pageIndex);
        if (folios) folios.push(obs);
        else folioNumbers.set(obs.pageIndex, [obs]);
    }
    const groups = new Map<string, { roman: boolean; prefix: string; offset: number; pages: Set<number>; removedPages: Set<number>; finalPages: Set<number>; counterPages: Set<number>; upper: number; lower: number; paddedPages: Map<number, number>; unpaddedPages: Map<number, number>; ems: number[]; removedEms: number[]; folioEvidence: number }>();
    for (const obs of observations) {
        if (obs.pageIndex < 0 || obs.pageIndex >= pageCount || obs.value < 1) continue;
        const offset = obs.value - obs.pageIndex;
        const prefix = obs.prefix ?? "";
        // An article number's page counter ("014105-3") starts at 1 within
        // the file; a counter already past 1 on the file's first page is a
        // volume and page ("92:1235"), whose folio is the page alone.
        if (COMPOUND_PREFIX_RE.test(prefix) && offset > 1) continue;
        const key = `${obs.roman ? "r" : "a"}${prefix}\u0000${offset}`;
        let group = groups.get(key);
        if (!group) {
            group = { roman: obs.roman, prefix, offset, pages: new Set(), removedPages: new Set(), finalPages: new Set(), counterPages: new Set(), upper: 0, lower: 0, paddedPages: new Map(), unpaddedPages: new Map(), ems: [], removedEms: [], folioEvidence: 0 };
            groups.set(key, group);
        }
        // One padding vote per page: a folio is often read more than once
        // (margin removal, its row's word, its own line).
        if (!obs.roman) {
            const width = paddedWidth(obs);
            if (width > 0) group.paddedPages.set(obs.pageIndex, Math.max(width, group.paddedPages.get(obs.pageIndex) ?? 0));
            else group.unpaddedPages.set(obs.pageIndex, String(obs.value).length);
        }
        if (!obs.headingRow) group.folioEvidence++;
        if (obs.em) (obs.edge ? group.ems : group.removedEms).push(obs.em);
        group.pages.add(obs.pageIndex);
        if (printsLastPage(obs)) group.finalPages.add(obs.pageIndex);
        if (isPageCounter(obs.text)) group.counterPages.add(obs.pageIndex);
        if (!obs.edge) group.removedPages.add(obs.pageIndex);
        if (obs.roman) {
            if (obs.text.trim() === obs.text.trim().toUpperCase()) group.upper++;
            else group.lower++;
        }
    }

    const minPages = pageCount <= SHORT_DOCUMENT_PAGES ? 2 : MIN_RUN_PAGES;
    const runs: Run[] = [];
    const numberedPages = new Map<number, Set<string>>();
    for (const [key, group] of groups) {
        // Numbers read only from rows no other page repeats (numbered
        // headings) are no numbering of the pages.
        if (group.folioEvidence === 0) continue;
        const pages = Array.from(group.pages).sort((a, b) => a - b);
        pages.forEach((page, k) => {
            const near = (k > 0 && page - pages[k - 1] <= MAX_RUN_GAP)
                || (k + 1 < pages.length && pages[k + 1] - page <= MAX_RUN_GAP);
            if (!near && !group.counterPages.has(page)) return;
            let keys = numberedPages.get(page);
            if (!keys) {
                keys = new Set();
                numberedPages.set(page, keys);
            }
            keys.add(key);
        });
        if (group.pages.size < minPages) continue;
        let start = 0;
        for (let k = 1; k <= pages.length; k++) {
            if (k < pages.length && pages[k] - pages[k - 1] <= MAX_RUN_GAP) continue;
            if (k - start >= minPages) {
                const runPages = pages.slice(start, k);
                runs.push({
                    key,
                    roman: group.roman,
                    prefix: group.prefix,
                    padding: padding(group.paddedPages, group.unpaddedPages),
                    folioEm: median(group.removedEms.length > 0 ? group.removedEms : group.ems) || undefined,
                    offset: group.offset,
                    pages: runPages,
                    weight: runPages.length
                        + runPages.filter((p) => group.removedPages.has(p)).length,
                    upperCase: group.upper > group.lower,
                    endsDocument: group.finalPages.has(runPages[runPages.length - 1]),
                });
            }
            start = k;
        }
    }
    // Pages each numbering prints as its last ("3 of 3").
    const lastPages = new Map(Array.from(groups, ([key, group]) => [key, group.finalPages]));
    return { runs, numberedPages, folioNumbers, lastPages };
}

/**
 * Largest difference between the number a run would give a page and a
 * different folio the page prints, for the page to count as numbered apart
 * from the run.
 */
const SHIFTED_NUMBER_DISTANCE = 2;

/**
 * Largest ratio between the font sizes of a shifted number and the run's
 * folios for the number to count as one of its folios.
 */
const FOLIO_SIZE_RATIO = 1.5;

/**
 * Whether the page prints a folio (`candidateRuns`' folio numbers) close
 * to, but not, the run's number for it: the page's own folio when a page was
 * left out of or added to the file, so the run's offset no longer holds
 * there. A number far from the run's is another numeral (a chapter number
 * on an opening page) and does not count, nor does one set at another size
 * than the run's folios (a display chapter numeral "1" on the opener of a
 * book's first chapter). Without known font sizes a close number counts.
 */
function printsShiftedNumber(
    folios: readonly PageNumberObservation[] | undefined,
    run: Run,
    pageIndex: number,
): boolean {
    const expected = pageIndex + run.offset;
    return (folios ?? []).some((obs) =>
        obs.roman === run.roman
        && (obs.prefix ?? "") === run.prefix
        && obs.value !== expected
        && Math.abs(obs.value - expected) <= SHIFTED_NUMBER_DISTANCE
        && setLikeFolios(obs, run));
}

function setLikeFolios(obs: PageNumberObservation, run: Run): boolean {
    if (!obs.em || !run.folioEm) return true;
    return obs.em <= run.folioEm * FOLIO_SIZE_RATIO && obs.em * FOLIO_SIZE_RATIO >= run.folioEm;
}


/** A compound folio's prefix: an article number and a separator. */
const COMPOUND_PREFIX_RE = /\d[-–:]$/u;

/**
 * Digits an observation prints its number with when zero-padded ("07",
 * "Page 07 of 12", "- 07 -"), else 0: the digit group after its prefix that
 * reads as its value.
 */
function paddedWidth(obs: PageNumberObservation): number {
    const text = normalizeDigits(obs.text.trim());
    const prefix = obs.prefix ? normalizeDigits(obs.prefix) : "";
    const rest = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
    const digits = rest.match(/\d+/gu)?.find((group) => parseInt(group, 10) === obs.value);
    return digits && digits.length > 1 && digits[0] === "0" ? digits.length : 0;
}

/**
 * Width a numbering pads its numbers to with zeros ("01", "02", …, "10"):
 * the most common padded width, when pages printing a padded number
 * outnumber those printing one shorter than it without padding. A page with
 * a padded reading counts as padded. 0 when it does not pad.
 */
function padding(paddedPages: ReadonlyMap<number, number>, unpaddedPages: ReadonlyMap<number, number>): number {
    const widths = new Map<number, number>();
    for (const width of paddedPages.values()) widths.set(width, (widths.get(width) ?? 0) + 1);
    let width = 0;
    let count = 0;
    for (const [w, n] of widths) {
        if (n > count || (n === count && w > width)) [width, count] = [w, n];
    }
    let shorter = 0;
    for (const [page, length] of unpaddedPages) {
        if (!paddedPages.has(page) && length < width) shorter++;
    }
    return count > shorter ? width : 0;
}

/**
 * One numbering per stretch of pages. Runs are taken best attested first
 * (`Run.weight`); a run whose page span overlaps an accepted run's span is
 * dropped, so of two numberings printed on the same pages (journal
 * pagination in the header, "page 2 of 13" in the footer) only one remains.
 */
function selectRuns(runs: Run[]): Run[] {
    const ordered = [...runs].sort((a, b) =>
        b.weight - a.weight
        || b.pages.length - a.pages.length
        || span(b) - span(a)
        || b.offset - a.offset,
    );
    const accepted: Run[] = [];
    for (const run of ordered) {
        const [first, last] = [run.pages[0], run.pages[run.pages.length - 1]];
        const overlaps = accepted.some((other) =>
            first <= other.pages[other.pages.length - 1] && other.pages[0] <= last,
        );
        if (!overlaps) accepted.push(run);
    }
    return accepted;
}

function span(run: Run): number {
    return run.pages[run.pages.length - 1] - run.pages[0];
}

const ROMAN_DIGITS: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function toRoman(value: number, upperCase: boolean): string {
    if (value < 1 || value >= 4000) return "";
    let rest = value;
    let out = "";
    for (const [n, digits] of ROMAN_DIGITS) {
        while (rest >= n) {
            out += digits;
            rest -= n;
        }
    }
    return upperCase ? out.toUpperCase() : out;
}

/** Text rows `pageEdgeRowObservations` reads at each end of a page. */
const EDGE_ROWS = 2;

/**
 * Candidate page numbers in the topmost and bottommost text rows of each
 * page (`edgeRows` at each end), read with the page turned upright: on a
 * page whose text runs sideways (`/Rotate 90`), MuPDF's frame puts the
 * running heads at the left or right edge. `marginZone` is the zone the
 * orientation vote ignores (see `detectDominantTextOrientation`). Running heads and feet sit there whatever the page's margins;
 * on generous or scanned pages they fall outside the fixed margin zones
 * `MarginFilter` reads. Observations are marked `edge`.
 */
export function pageEdgeRowObservations(
    pages: readonly RawPageData[],
    edgeRows = EDGE_ROWS,
    marginZone: MarginSettings = DEFAULT_MARGIN_ZONE,
): PageNumberObservation[] {
    const observations: PageNumberObservation[] = [];
    // The text of the row each observation was read from, without digits,
    // and the pages whose edge rows print each such text.
    const rowTextOf = new Map<PageNumberObservation, string>();
    const pagesByRowText = new Map<string, Set<number>>();
    for (const page of pages) {
        const rotation = detectDominantTextOrientation(page, marginZone);
        const rows = textRows(rotateRawPage(page, rotation).page);
        const pageLines = rows.flat();
        // Observation boxes go back to MuPDF's frame, the frame margin
        // detection reports its boxes in.
        const sourceBox = (box: BoundingBox) =>
            inverseRotateBBox(box, rotation, page.width, page.height);
        // Where the page prints each candidate, per position and text.
        const pagePlaces = new Map<string, BoundingBox[]>();
        // The page's body em, which a large title does not stretch. Only
        // needed to tell places apart, so computed on first use.
        let pageEm: number | undefined;
        const em = () => pageEm ??= median(pageLines.map(emOf));
        const pageObservations: PageNumberObservation[] = [];
        const pageRowTexts = new Map<PageNumberObservation, string>();
        const picked = new Map<number, "top" | "bottom">();
        rows.slice(-edgeRows).forEach((_, k) => picked.set(rows.length - 1 - k, "bottom"));
        rows.slice(0, edgeRows).forEach((_, k) => picked.set(k, "top"));
        for (const [rowIndex, position] of picked) {
            const lines = rows[rowIndex];
            const rowText = lines.map((line) => line.text).join(" ");
            // The row's first and last word; a candidate word is one of them.
            const ends = rowEndWords(rowText);
            const otherText = rowTextKey(rowText);
            if (otherText) {
                const seen = pagesByRowText.get(otherText);
                if (seen) seen.add(page.pageIndex);
                else pagesByRowText.set(otherText, new Set([page.pageIndex]));
            }
            const rowStart = pageObservations.length;
            const uprightRowBox = unionBBox(lines);
            const rowBox = sourceBox(uprightRowBox);
            const spaced = spacedRowNumber(
                rowText,
                uprightRowBox.r - uprightRowBox.l,
                Math.max(...lines.map((line) => line.font?.size ?? 0)),
            );
            // Candidate texts with their boxes: the row's first and last word
            // take the box of the line they start and end, a line read on its
            // own its own box, the whole row the row's box.
            const texts = new Map<string, BoundingBox>();
            // Font size of the line (or row) each candidate was read from.
            const ems = new Map<string, number>();
            const rowEm = Math.max(...lines.map(emOf));
            // Where the row prints each candidate, upright: the same numeral
            // read as a word and as a line is one place (see `distinctPlaces`).
            // The single digits of broken-up rows (a letter-spaced footer, a
            // line set glyph by glyph) all share one place on the page.
            const scattered = lines.filter((line) => [...line.text.trim()].length === 1).length >= SCATTERED_MIN_CHARACTERS
                || isScatteredRow(rowText);
            const placed = (text: string, ...boxes: BoundingBox[]) => {
                const key = `${position}\u0000${text}`;
                const where = scattered && [...text].length === 1 ? [SCATTERED_PLACE] : boxes;
                pagePlaces.set(key, [...(pagePlaces.get(key) ?? []), ...where]);
            };
            if (!spaced) {
                const firstLine = lines[0];
                const lastLine = lines[lines.length - 1];
                // A footnote line's marker steps with the pages as well.
                const marker = isFootnoteMarker(firstLine, pageLines) ? ends[0] : undefined;
                const bothEnds = ends.length === 2 && ends[0] === ends[1] && !scattered;
                for (const word of rowPageNumberWords(rowText)) {
                    if (word === marker) continue;
                    const line = word === ends[0] ? firstLine : lastLine;
                    texts.set(word, sourceBox(line.bbox));
                    ems.set(word, emOf(line));
                    if (bothEnds) placed(word, ...rowEndBoxes(uprightRowBox, em()));
                    else placed(word, line.bbox);
                }
                // The whole row first: a counter split into lines ("Page 3",
                // "of 3") still reads as one, keeping its last-page signal. A
                // row that opens with a footnote marker (one raised into a row
                // of its own) is not a counter.
                if (marker === undefined && parsePrintedPageNumber(rowText)) {
                    texts.set(rowText.trim(), rowBox);
                    ems.set(rowText.trim(), rowEm);
                    placed(rowText.trim(), uprightRowBox);
                }
            }
            // A line read on its own: a prefixed folio only where the row
            // reads it as well (not "S1" after a line "Figure").
            let rowWords: Set<string> | undefined;
            for (const line of lines) {
                const parsed = parsePrintedPageNumber(line.text);
                if (parsed?.prefix) {
                    rowWords ??= new Set(rowPageNumberWords(rowText));
                    if (!rowWords.has(normalizeDigits(line.text).trim())) continue;
                }
                if (parsed && !isFootnoteMarker(line, pageLines)) {
                    const text = line.text.trim();
                    texts.set(text, sourceBox(line.bbox));
                    ems.set(text, emOf(line));
                    placed(text, line.bbox);
                }
            }
            if (spaced) {
                pageObservations.push({
                    pageIndex: page.pageIndex,
                    value: Number(spaced),
                    text: spaced,
                    roman: false,
                    position,
                    edge: true,
                    spaced: true,
                    bbox: rowBox,
                    em: rowEm,
                });
            }
            for (const [text, bbox] of texts) {
                const parsed = parsePrintedPageNumber(text);
                if (!parsed) continue;
                pageObservations.push({
                    pageIndex: page.pageIndex,
                    value: parsed.value,
                    text,
                    roman: parsed.roman,
                    ...(parsed.prefix ? { prefix: parsed.prefix } : {}),
                    position,
                    edge: true,
                    bbox,
                    em: ems.get(text),
                });
            }
            // A numbered heading opens its row with an Arabic number and a
            // title ("2 Methods"), and counts sections from the document's
            // start, so its number is at most the page's position: a folio
            // of an article or excerpt ("644 R. Allen …") runs ahead of it.
            // Folios at a row's end, Roman folios and bare numbers read as
            // they are.
            if (otherText) {
                for (const obs of pageObservations.slice(rowStart)) {
                    if (
                        !obs.roman
                        && !obs.spaced
                        && obs.value <= page.pageIndex + 1
                        && normalizeDigits(obs.text).trim() === ends[0]
                    ) {
                        pageRowTexts.set(obs, otherText);
                    }
                }
            }
        }
        for (const obs of pageObservations) {
            // One box or none is that many places, whatever the em.
            const boxes = pagePlaces.get(`${obs.position}\u0000${obs.text}`) ?? [];
            const n = boxes.length > 1 ? distinctPlaces(boxes, em()) : boxes.length;
            const counted = n > 1 ? { ...obs, occurrences: n } : obs;
            const rowText = pageRowTexts.get(obs);
            if (rowText) rowTextOf.set(counted, rowText);
            observations.push(counted);
        }
    }
    // A running head's text recurs on other pages (an author line and a
    // title, alternating; "Page … of …"); a numbered heading's is its own.
    return observations.map((obs) => {
        const rowText = rowTextOf.get(obs);
        return rowText && (pagesByRowText.get(rowText)?.size ?? 0) < 2 ? { ...obs, headingRow: true } : obs;
    });
}

/** A row's text without its digits and marks, lowercased: "" for a bare number. */
function rowTextKey(rowText: string): string {
    return rowText.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
}

/**
 * A page's text lines grouped into rows, top to bottom, each left to right.
 * A line joins the current row when its center is within tolerance of the
 * row's first line (its anchor).
 */
function textRows(page: RawPageData): RawLine[][] {
    const entries: { line: RawLine; center: number; height: number }[] = [];
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            if (line.text.trim()) entries.push({ line, center: center(line), height: height(line) });
        }
    }
    entries.sort((a, b) => a.center - b.center);
    const rows: RawLine[][] = [];
    let anchor: (typeof entries)[number] | undefined;
    for (const entry of entries) {
        if (anchor && Math.abs(entry.center - anchor.center) <= Math.max(2, 0.5 * Math.min(anchor.height, entry.height))) {
            rows[rows.length - 1].push(entry.line);
        } else {
            rows.push([entry.line]);
            anchor = entry;
        }
    }
    for (const row of rows) row.sort((a, b) => a.bbox.l - b.bbox.l);
    return rows;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function center(line: RawLine): number {
    return (line.bbox.t + line.bbox.b) / 2;
}

function height(line: RawLine): number {
    return line.bbox.b - line.bbox.t;
}
