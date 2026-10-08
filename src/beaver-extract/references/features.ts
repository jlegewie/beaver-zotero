/**
 * Features of the reference classifier.
 *
 * Item features describe one item on its own: the shape of its text
 * (author list, year, venue, page range, DOI), its typography and its
 * geometry (hanging indent, line fill). Context features place the item in
 * the document: whether a reference-list heading precedes it and where the
 * page sits. The classifier's second stage adds the first-stage scores of
 * neighbouring items (see `model.ts`).
 *
 * Everything here is a pure function of `InputPage` inputs, so the training
 * export and the worker compute identical values. The parts other models
 * read too live in `../features/`.
 */

import { listContext, pagePosition } from "../features/context";
import { clamp, lineBlockGeometry, median } from "../features/geometry";
import type { InputItem, InputLine, InputPage } from "../features/itemInput";
import {
    AUTHOR_LEADER,
    DOI_RE,
    IN_EDS_RE,
    NUMBERED_RE,
    PAGE_RANGE_RE,
    SURNAME,
    URL_RE,
    VENUE_RE,
    VOL_ISSUE_RE,
    YEAR_RE,
    countMatches,
    scanText,
    scanWindow,
} from "../features/text";

export const FEATURE_VERSION = 8;

export const ITEM_FEATURES = [
    "len",
    "lines",
    "header",
    "numbered",
    "bareNumber",
    "leadSmall",
    "romanLeader",
    "authorStart",
    "vancouverStart",
    "initialsStart",
    "dashStart",
    "cjkAuthorYear",
    "yearEarly",
    "parenYear",
    "years",
    "initials",
    "etAl",
    "doi",
    "url",
    "pageRange",
    "volIssue",
    "vancouverCite",
    "docTypeCode",
    "inEds",
    "venueWord",
    "quotedTitle",
    "refMarkers",
    "noteCues",
    "prose",
    "digits",
    "capWords",
    "commas",
    "periods",
    "semicolons",
    "endsPeriod",
    "endsNumber",
    "startsLower",
    "hangEntry",
    "hangCont",
    "hangIndent",
    "firstIndent",
    "lastFill",
    "width",
    "top",
    "lineGap",
] as const;

export const CONTEXT_FEATURES = [
    "docPos",
    "fromEnd",
    "refHeading",
    "refHeadingPage",
    "sinceHeading",
    "headingsAfter",
    "listHeading",
    "notesHeading",
    "numberSeq",
] as const;

export type ItemFeatureName = (typeof ITEM_FEATURES)[number];
export type ContextFeatureName = (typeof CONTEXT_FEATURES)[number];

// ---------------------------------------------------------------------------
// Reference text patterns
// ---------------------------------------------------------------------------

/** A bare list number before a capitalized word: "5 Centers for Medicare …" */
const BARE_NUMBER_RE = /^\s*\d{1,4}\s+(?=[\p{Lu}“"‘'])/u;
/** A lowercase roman note marker: "iv Former US President …" */
const ROMAN_LEADER_RE = /^\s*[ivxl]{1,5}\s+(?=[\p{Lu}“"‘'])/u;
/** Chinese / Japanese author–year start: "陈耿，刘星. 2015." */
const CJK_AUTHOR_YEAR_RE = /^\s*(?:\[\d{1,4}\]\s*)?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,5}(?:[，、,・][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,5})*(?:[，,]?\s*等)?\s*[.．。，,(（]\s*(?:1[89]\d\d|20[0-3]\d)/u;
/** Vancouver citation tail: "2020;22(12):e24255", "1998;44:61–7" */
const VANCOUVER_CITE_RE = /(?:1[89]\d\d|20[0-3]\d)(?:\s?[A-Z][a-z]{2}(?:\s?\d{1,2})?)?\s?;\s?\d{1,4}(?:\s?\([^)]{1,12}\))?\s?:\s?[eE]?\d/;
/** GB/T 7714 document-type codes: "[J]", "[M]", "[EB/OL]" */
const DOC_TYPE_CODE_RE = /\[(?:J|M|C|D|R|N|P|S|Z|A|G|DB|CP|EB|EB\/OL|J\/OL|M\/OL|DB\/OL)\]/;
/** "Smith, J." / "Smith, John;" / "SMITH, J." / "van der Berg, A." */
const AUTHOR_START_RE = new RegExp(
    `^\\s*(?:${AUTHOR_LEADER})?${SURNAME},?\\s+(?:\\p{Lu}\\.|\\p{Lu}[\\p{Ll}]+[-,;.\\s(]|\\p{Lu}\\p{Lu}?\\.?[,;\\s])`,
    "u",
);
/** "N. Armitage," / "J.-P. Sartre" / "A.B. Smith" */
const INITIALS_START_RE = new RegExp(
    `^\\s*(?:${AUTHOR_LEADER})?(?:\\p{Lu}\\.\\s?(?:-\\s?\\p{Lu}\\.\\s?)?){1,3}\\s?${SURNAME}`,
    "u",
);
/** A repeated-author rule: "———." / "——, ed." / "---." */
const DASH_START_RE = /^\s*(?:[—–-]\s?){2,}/u;
/** Vancouver / compact styles: "Smith JA," "Smith JA." "Smith J A" */
const VANCOUVER_RE = new RegExp(`^\\s*(?:${AUTHOR_LEADER})?${SURNAME}\\s+\\p{Lu}{1,3}[,.]?\\s`, "u");
const PAREN_YEAR_RE = /\((?:1[5-9]\d\d|20[0-3]\d)[a-z]?(?:[,;][^)]{0,20})?\)/;
const ET_AL_RE = /\b[Ee]t\s?al\b/;
const QUOTED_RE = /[“"«„][^”"»“]{8,}[”"»“]/;
const REF_MARKER_RE = /\[(?:Cross[Rr]ef|PubMed|Google Scholar|Ref list|DOI|PMC free article|Internet|[Cc]ited [^\]]{3,30}|[Ss]erial[^\]]{0,30})\]|\b(?:[Rr]etrieved|[Aa]ccessed|[Aa]vailable (?:at|from|online)|ISBN|ISSN|arXiv|PMID|PMCID|Google Scholar)\b/;
/** Footnote and endnote idioms. */
const NOTE_CUES_RE =
    /(?:^|[\s(])(?:[Ii]bid\b|[Ii]dem\b|[Ii]d\.|op\.\s?cit|loc\.\s?cit|[Cc]f\.|[Ss]ee(?:,? e\.g\.,| also)?\s+[A-ZÀ-Þ]|[Qq]uoted (?:in|from)\b|[Ee]mphasis (?:added|in original)|[Vv]gl\.|a\.a\.O\.|[Ee]benda\b)/;


/** Features of one item on its own (`ITEM_FEATURES` order). */
export function itemFeatures(item: InputItem, page: InputPage): number[] {
    const full = item.text.trim();
    const text = scanWindow(full);
    const lines: InputLine[] = item.lines.length > 0 ? item.lines : [];
    const counts = scanText(text);
    const nWords = Math.max(1, counts.words);
    const { prose, capWords, digits } = counts;

    const head = text.slice(0, Math.max(150, Math.round(text.length * 0.3)));
    YEAR_RE.lastIndex = 0;
    const yearEarly = YEAR_RE.test(head) ? 1 : 0;

    // The em: body size, else the item's own median line size.
    const size = median(lines.map((line) => line.size));
    const em = page.bodySize > 0 ? page.bodySize : size > 0 ? size : 10;
    const { hangCont, hangIndent, lastFill, lineGap, firstIndent, left, right, top } = lineBlockGeometry(lines, em);

    const f: Record<ItemFeatureName, number> = {
        len: Math.log1p(full.length) / 8,
        lines: Math.min(lines.length, 20) / 10,
        header: item.header ? 1 : 0,
        numbered: NUMBERED_RE.test(text) ? 1 : 0,
        bareNumber: BARE_NUMBER_RE.test(text) ? 1 : 0,
        leadSmall: lines.length > 0 && lines[0].lead < 0.85 ? 1 : 0,
        romanLeader: ROMAN_LEADER_RE.test(text) ? 1 : 0,
        authorStart: AUTHOR_START_RE.test(text) ? 1 : 0,
        vancouverStart: VANCOUVER_RE.test(text) ? 1 : 0,
        initialsStart: INITIALS_START_RE.test(text) ? 1 : 0,
        dashStart: DASH_START_RE.test(text) ? 1 : 0,
        cjkAuthorYear: CJK_AUTHOR_YEAR_RE.test(text) ? 1 : 0,
        yearEarly,
        parenYear: PAREN_YEAR_RE.test(text) ? 1 : 0,
        years: Math.min(countMatches(YEAR_RE, text), 4) / 4,
        initials: Math.min(counts.initials / nWords, 0.5) * 2,
        etAl: ET_AL_RE.test(text) ? 1 : 0,
        doi: DOI_RE.test(text) ? 1 : 0,
        url: URL_RE.test(text) ? 1 : 0,
        pageRange: PAGE_RANGE_RE.test(text) ? 1 : 0,
        volIssue: VOL_ISSUE_RE.test(text) ? 1 : 0,
        vancouverCite: VANCOUVER_CITE_RE.test(text) ? 1 : 0,
        docTypeCode: DOC_TYPE_CODE_RE.test(text) ? 1 : 0,
        inEds: IN_EDS_RE.test(text) ? 1 : 0,
        venueWord: VENUE_RE.test(text) ? 1 : 0,
        quotedTitle: QUOTED_RE.test(text) ? 1 : 0,
        refMarkers: REF_MARKER_RE.test(text) ? 1 : 0,
        noteCues: NOTE_CUES_RE.test(text) ? 1 : 0,
        prose: Math.min(prose / nWords, 0.5) * 2,
        digits: Math.min(digits / Math.max(1, text.length), 0.5) * 2,
        capWords: capWords / nWords,
        commas: Math.min(counts.commas / nWords, 1),
        periods: Math.min(counts.periods / nWords, 1),
        semicolons: Math.min(counts.semicolons / nWords, 0.5) * 2,
        endsPeriod: /[.]["'”’)\]]?$/u.test(text) ? 1 : 0,
        endsNumber: /[\d)\]]$/u.test(text) ? 1 : 0,
        startsLower: /^\p{Ll}/u.test(text) ? 1 : 0,
        hangEntry: lines.length > 0 && lines[0].role === 1 ? 1 : 0,
        hangCont,
        hangIndent,
        firstIndent,
        lastFill,
        width: page.width > 0 ? clamp((right - left) / page.width, 0, 1) : 0,
        top: page.height > 0 ? clamp(top / page.height, 0, 1) : 0,
        lineGap,
    };
    return ITEM_FEATURES.map((name) => f[name]);
}

/**
 * Context features for every item of a document, in page and reading order.
 * `pages` must be the document's pages in order; `pageCount` its page count.
 */
export function contextFeatures(pages: readonly InputPage[], pageCount: number): number[][][] {
    const lists = listContext(pages);
    return pages.map((page, p) => {
        const { docPos, fromEnd } = pagePosition(page.pageIndex, pageCount);
        return lists[p].map((c) => {
            const f: Record<ContextFeatureName, number> = {
                docPos,
                fromEnd,
                refHeading: c.refHeadingBefore ? 1 : 0,
                refHeadingPage: c.refHeadingOnPage ? 1 : 0,
                sinceHeading: c.refHeadingBefore ? Math.min(Math.log1p(c.sinceRefHeading) / 5, 1) : 0,
                headingsAfter: Math.min(c.headingsAfterRef, 3) / 3,
                listHeading: c.listHeading ? 1 : 0,
                notesHeading: c.notesBefore ? 1 : 0,
                numberSeq: c.numberSeq ? 1 : 0,
            };
            return CONTEXT_FEATURES.map((name) => f[name]);
        });
    });
}
