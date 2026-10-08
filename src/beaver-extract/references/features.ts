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
 * Everything here is a pure function of `RefPage` inputs, so the training
 * export and the worker compute identical values.
 */

import type { RefItem, RefLine, RefPage } from "./pageInput";

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
// Text patterns
// ---------------------------------------------------------------------------

const LEADER = String.raw`(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)](?!\d))\s*`;
/** A list leader, or a bare list number before the author ("16 Schwamm LH, …"). */
const AUTHOR_LEADER = String.raw`(?:${LEADER}|\d{1,4}\s+(?=\p{Lu}))`;
const SURNAME = String.raw`(?:(?:van|von|de|da|del|della|der|den|di|du|le|la|dos|das|ten|ter|mc|mac|o')\s?)*\p{Lu}[\p{L}'’\-]+(?:[\s\-]\p{Lu}[\p{L}'’\-]+)?`;
const NUMBERED_RE = new RegExp(`^\\s*${LEADER}\\S`, "u");
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
const YEAR_RE = /(?<![\d/.])(?:1[5-9]\d\d|20[0-3]\d)[a-z]?(?![\d])/g;
const PAREN_YEAR_RE = /\((?:1[5-9]\d\d|20[0-3]\d)[a-z]?(?:[,;][^)]{0,20})?\)/;
const ET_AL_RE = /\b[Ee]t\s?al\b/;
const DOI_RE = /\b(?:doi|DOI|Doi)\b|\b10\.\d{4,9}\//;
const URL_RE = /https?:\/\/|www\.|\.(?:org|com|edu|gov)\b/i;
const PAGE_RANGE_RE = /\bpp?\.\s*\d|\b\d{1,5}\s*[–—~～-]\s*\d{1,5}\b/;
const VOL_ISSUE_RE = /\b\d{1,4}\s?\(\s?\d{1,4}(?:\s?[–-]\s?\d{1,4})?\s?\)|\b(?:[Vv]ol|VOL|[Nn]o|NO|[Nn]r|[Bb]d|[Jj]g|[Hh]eft)\.\s?\d/;
const IN_EDS_RE = /(?:^|[\s.,])In:?\s+[A-ZÀ-Þ]|\(eds?\.?\)|\beds?\.\s|\bed\. by\b|\(Hrsg\.?\)|\bHrsg\.|\(Hg\.?\)|\(dir\.\)|\(coord\.\)/;
const VENUE_RE = /\b(?:Press|Publishers?|Publishing|Verlag|Journal|Review|Proceedings|Conference|Symposium|Quarterly|Annals|Bulletin|Letters|Transactions|Editions|Éditions|Books|Zeitschrift|Revista|Revue|Rivista|Thesis|Dissertation|Working Paper|Report|Univ\.|University)\b/;
const QUOTED_RE = /[“"«„][^”"»“]{8,}[”"»“]/;
const REF_MARKER_RE = /\[(?:Cross[Rr]ef|PubMed|Google Scholar|Ref list|DOI|PMC free article|Internet|[Cc]ited [^\]]{3,30}|[Ss]erial[^\]]{0,30})\]|\b(?:[Rr]etrieved|[Aa]ccessed|[Aa]vailable (?:at|from|online)|ISBN|ISSN|arXiv|PMID|PMCID|Google Scholar)\b/;
/** Footnote and endnote idioms. */
const NOTE_CUES_RE =
    /(?:^|[\s(])(?:[Ii]bid\b|[Ii]dem\b|[Ii]d\.|op\.\s?cit|loc\.\s?cit|[Cc]f\.|[Ss]ee(?:,? e\.g\.,| also)?\s+[A-ZÀ-Þ]|[Qq]uoted (?:in|from)\b|[Ee]mphasis (?:added|in original)|[Vv]gl\.|a\.a\.O\.|[Ee]benda\b)/;
const PROSE_WORDS = new Set([
    "we", "our", "us", "is", "are", "was", "were", "that", "this", "these", "those", "which",
    "has", "have", "had", "be", "been", "being", "can", "could", "may", "might", "will",
    "would", "should", "not", "it", "its", "there", "however", "thus", "therefore", "also",
    "because", "when", "while", "than", "here", "such", "they", "their", "he", "she", "his",
    "her", "you", "i", "do", "does", "did", "if", "but", "so", "very", "more", "most",
]);
const NON_ASCII_WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const NON_ASCII_LETTER_RE = /\p{L}/u;

function isWhitespace(code: number): boolean {
    return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
        code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

function isAsciiLetter(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLetterAt(text: string, i: number): boolean {
    const code = text.charCodeAt(i);
    return code < 128 ? isAsciiLetter(code) : NON_ASCII_LETTER_RE.test(text[i]);
}

function isWordCharAt(text: string, i: number): boolean {
    const code = text.charCodeAt(i);
    return code < 128
        ? isAsciiLetter(code) || (code >= 48 && code <= 57)
        : NON_ASCII_WORD_CHAR_RE.test(text[i]);
}

/** Uppercase letter (cased letters only). */
function isUpperAt(text: string, i: number): boolean {
    const code = text.charCodeAt(i);
    if (code < 128) return code >= 65 && code <= 90;
    const ch = text[i];
    return ch !== ch.toLowerCase();
}

/** Longest word in `PROSE_WORDS`; longer words are never looked up. */
const PROSE_WORD_MAX = 9;

/**
 * Word and character counts of a text in one pass: words (whitespace-split,
 * leading punctuation dropped), capitalized and prose words, digits, commas,
 * periods, semicolons, and initials ("J." after a non-letter, before a space,
 * comma, hyphen, capital or the end).
 */
function scanText(text: string) {
    const out = { words: 0, prose: 0, capWords: 0, digits: 0, commas: 0, periods: 0, semicolons: 0, initials: 0 };
    const n = text.length;
    let i = 0;
    while (i < n) {
        while (i < n && isWhitespace(text.charCodeAt(i))) i++;
        if (i >= n) break;
        let end = i;
        while (end < n && !isWhitespace(text.charCodeAt(end))) end++;
        let start = i;
        while (start < end && !isWordCharAt(text, start)) start++;
        if (start < end) {
            out.words++;
            if (isUpperAt(text, start)) out.capWords++;
            let stop = start;
            while (stop < end && stop - start <= PROSE_WORD_MAX) {
                const code = text.charCodeAt(stop);
                if (code !== 39 && code !== 0x2019 && code !== 45 && !isLetterAt(text, stop)) break;
                stop++;
            }
            if (stop - start <= PROSE_WORD_MAX && (stop === end || !isLetterAt(text, stop)) &&
                PROSE_WORDS.has(text.slice(start, stop).toLowerCase())) {
                out.prose++;
            }
        }
        i = end;
    }
    for (let k = 0; k < n; k++) {
        const code = text.charCodeAt(k);
        if (code >= 48 && code <= 57) out.digits++;
        else if (code === 44) out.commas++;
        else if (code === 59) out.semicolons++;
        else if (code === 46) {
            out.periods++;
            if (k > 0 && isUpperAt(text, k - 1) && (k < 2 || !isLetterAt(text, k - 2))) {
                const next = k + 1 < n ? text.charCodeAt(k + 1) : -1;
                if (next === -1 || next === 44 || next === 45 || isWhitespace(next) || isUpperAt(text, k + 1)) {
                    out.initials++;
                }
            }
        }
    }
    return out;
}

/**
 * What may open a heading before its words: a bullet or ornament ("■ References"),
 * a section number ("6.", "IV") or a letter enumerator ("G. Bibliography").
 */
const HEADING_LEAD = String.raw`(?:[^\p{L}\p{N}\s]{1,3}\s*)?(?:[\dIVX]+\.?\s*|\p{Lu}[.)]\s*)?`;
/** A place and its publisher: "Upper Saddle River, NJ: Prentice Hall", "London, UK: Sage". */
const PLACE_PUBLISHER_RE = /\p{Lu}[\p{L}.]+,\s?\p{Lu}{2}\s?:/u;

/**
 * Whether text carries a bibliographic detail: a year, a page range, a
 * volume or issue, a DOI or link, a venue or publisher word, an editor
 * statement or a place and publisher.
 */
export function hasBibliographicDetail(text: string): boolean {
    YEAR_RE.lastIndex = 0;
    return (
        YEAR_RE.test(text) ||
        PAGE_RANGE_RE.test(text) ||
        VOL_ISSUE_RE.test(text) ||
        DOI_RE.test(text) ||
        URL_RE.test(text) ||
        VENUE_RE.test(text) ||
        IN_EDS_RE.test(text) ||
        PLACE_PUBLISHER_RE.test(text)
    );
}

/** Words of running prose in a text ("is", "this", "we", …; see `PROSE_WORDS`). */
export function proseWordCount(text: string): number {
    return scanText(text).prose;
}

/** Unambiguous reference-list headings (also accepted on short non-heading items). */
const REF_HEADING_RE = new RegExp(
    String.raw`^\s*${HEADING_LEAD}(?:references?(?: (?:and|&) (?:notes|links|bibliography|(?:recommended|suggested) readings?)| cited| list)?|additional references|bibliograph(?:y|ie|ies|ía|ia)(?: and references)?|works (?:cited|consulted)|literature cited|cited literature|literaturverzeichnis|quellenverzeichnis|références(?: bibliographiques)?|referencias(?: bibliográficas)?|referências(?: bibliográficas)?|riferimenti bibliografici|bibliografía|bibliografia|literatuur|litteratur|referenser|kaynakça|список литературы|литература|参考文献|參考文獻|(?:further|suggested|recommended) readings?|select(?:ed)? bibliograph(?:y|ies)|sources cited|reference list|(?:主要)?参考文献|參考文獻|引用文献|文献|참고문헌)\s*[:.]?\s*$`,
    "iu",
);
/** Note-section headings: the list that follows is notes, not references. */
const NOTES_HEADING_RE = new RegExp(
    String.raw`^\s*${HEADING_LEAD}(?:notes|endnotes|footnotes|anmerkungen|endnoten|fußnoten|fussnoten|notas|note|noten)\s*[:.]?\s*$`,
    "iu",
);
/** Ambiguous headings: count only when the detector read the item as a heading. */
const AMBIGUOUS_HEADING_RE = new RegExp(
    String.raw`^\s*${HEADING_LEAD}(?:literature|literatur|sources|quellen|notes and references|references and further reading|data sources)\s*[:.]?\s*$`,
    "iu",
);

function count(re: RegExp, text: string): number {
    re.lastIndex = 0;
    let n = 0;
    while (re.exec(text) !== null) n++;
    return n;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Whether the item reads as a notes-section heading. */
export function isNotesHeading(item: RefItem): boolean {
    const text = item.text.trim();
    return text.length <= 40 && NOTES_HEADING_RE.test(text);
}

/** Leading list number of an item ("[12]", "12.", "(12)"), or null. */
export function leadingNumber(text: string): number | null {
    let i = 0;
    while (i < text.length && isWhitespace(text.charCodeAt(i))) i++;
    const code = text.charCodeAt(i);
    if (code !== 91 && code !== 40 && !(code >= 48 && code <= 57)) return null;
    const m = /^\s*(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4})[.)](?!\d)|(\d{1,4})\s+(?=\p{Lu}))/u.exec(text);
    if (!m) return null;
    return Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/** Whether the item reads as a reference-list heading. */
export function isReferenceHeading(item: RefItem): boolean {
    const text = item.text.trim();
    if (text.length > 60) return false;
    if (REF_HEADING_RE.test(text)) return true;
    return item.header && AMBIGUOUS_HEADING_RE.test(text);
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Text patterns are read from at most this many leading and trailing
 * characters. Reference entries are shorter; for long body paragraphs this
 * bounds the cost without changing what the features say about them.
 */
const SCAN_HEAD = 800;
const SCAN_TAIL = 400;

/** Features of one item on its own (`ITEM_FEATURES` order). */
export function itemFeatures(item: RefItem, page: RefPage): number[] {
    const full = item.text.trim();
    const text = full.length > SCAN_HEAD + SCAN_TAIL
        ? `${full.slice(0, SCAN_HEAD)} ${full.slice(-SCAN_TAIL)}`
        : full;
    const lines: RefLine[] = item.lines.length > 0 ? item.lines : [];
    const counts = scanText(text);
    const nWords = Math.max(1, counts.words);
    const { prose, capWords, digits } = counts;

    const head = text.slice(0, Math.max(150, Math.round(text.length * 0.3)));
    YEAR_RE.lastIndex = 0;
    const yearEarly = YEAR_RE.test(head) ? 1 : 0;

    // The em: body size, else the item's own median line size.
    const size = median(lines.map((line) => line.size));
    const em = page.bodySize > 0 ? page.bodySize : size > 0 ? size : 10;

    // Geometry.
    let hangCont = 0;
    let hangIndent = 0;
    let lastFill = 1;
    let lineGap = 0;
    if (lines.length >= 2) {
        let cont = 0;
        let minRest = Infinity;
        let maxR = -Infinity;
        let minL = Infinity;
        const gaps: number[] = [];
        for (let k = 0; k < lines.length; k++) {
            const line = lines[k];
            maxR = Math.max(maxR, line.r);
            minL = Math.min(minL, line.l);
            if (k > 0) {
                if (line.role === 2) cont++;
                minRest = Math.min(minRest, line.l);
                gaps.push(line.t - lines[k - 1].b);
            }
        }
        hangCont = cont / (lines.length - 1);
        hangIndent = clamp((minRest - lines[0].l) / em, -3, 5) / 5;
        const last = lines[lines.length - 1];
        lastFill = maxR > minL ? clamp((last.r - minL) / (maxR - minL), 0, 1) : 1;
        lineGap = clamp(median(gaps) / em, -1, 3) / 3;
    }
    const left = lines.length > 0 ? Math.min(...lines.map((l) => l.l)) : 0;
    const right = lines.length > 0 ? Math.max(...lines.map((l) => l.r)) : 0;
    const top = lines.length > 0 ? Math.min(...lines.map((l) => l.t)) : 0;
    const firstIndent = lines.length > 0 ? clamp((lines[0].l - left) / em, 0, 5) / 5 : 0;

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
        years: Math.min(count(YEAR_RE, text), 4) / 4,
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
export function contextFeatures(pages: readonly RefPage[], pageCount: number): number[][][] {
    // Leading list numbers in document reading order, for the sequence test.
    const numbers: (number | null)[] = [];
    for (const page of pages) for (const item of page.items) numbers.push(leadingNumber(item.text));

    const out: number[][][] = [];
    let headingSeen = false;
    let notesLast = false;
    let sinceHeading = 0;
    let headingsAfter = 0;
    let flat = 0;
    for (const page of pages) {
        const docPos = pageCount > 1 ? page.pageIndex / (pageCount - 1) : 1;
        const fromEnd = Math.min(pageCount - 1 - page.pageIndex, 20) / 20;
        let headingOnPage = false;
        const rows: number[][] = [];
        for (const item of page.items) {
            const listHeading = isReferenceHeading(item);
            const notesHeading = !listHeading && isNotesHeading(item);
            if (listHeading) {
                headingSeen = true;
                headingOnPage = true;
                sinceHeading = 0;
                headingsAfter = 0;
                notesLast = false;
            } else if (notesHeading) {
                notesLast = true;
            }
            const n = numbers[flat];
            const prev = flat > 0 ? numbers[flat - 1] : null;
            const next = flat + 1 < numbers.length ? numbers[flat + 1] : null;
            const numberSeq = n !== null && ((prev !== null && prev === n - 1) || (next !== null && next === n + 1));
            const f: Record<ContextFeatureName, number> = {
                docPos,
                fromEnd,
                refHeading: headingSeen && !listHeading ? 1 : 0,
                refHeadingPage: headingOnPage && !listHeading ? 1 : 0,
                sinceHeading: headingSeen && !listHeading ? Math.min(Math.log1p(sinceHeading) / 5, 1) : 0,
                headingsAfter: Math.min(headingsAfter, 3) / 3,
                listHeading: listHeading ? 1 : 0,
                notesHeading: notesLast && !notesHeading ? 1 : 0,
                numberSeq: numberSeq ? 1 : 0,
            };
            rows.push(CONTEXT_FEATURES.map((name) => f[name]));
            if (!listHeading && headingSeen) {
                sinceHeading++;
                if (item.header) headingsAfter++;
            }
            flat++;
        }
        out.push(rows);
    }
    return out;
}
