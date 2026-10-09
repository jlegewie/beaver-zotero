/**
 * Text patterns shared by the item models: word and character counts, list
 * leaders, bibliographic details and list headings. Pure functions of a text,
 * so the worker and the training export compute the same values.
 */

/** A list leader: "[12]", "(12)", "12." or "12)". */
export const LEADER = String.raw`(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)](?!\d))\s*`;
/** A list leader, or a bare list number before the author ("16 Schwamm LH, …"). */
export const AUTHOR_LEADER = String.raw`(?:${LEADER}|\d{1,4}\s+(?=\p{Lu}))`;
/** A surname, with particles ("van der Berg") and a second part ("Smith-Jones"). */
export const SURNAME = String.raw`(?:(?:van|von|de|da|del|della|der|den|di|du|le|la|dos|das|ten|ter|mc|mac|o')\s?)*\p{Lu}[\p{L}'’\-]+(?:[\s\-]\p{Lu}[\p{L}'’\-]+)?`;
/** Text that opens with a list leader. */
export const NUMBERED_RE = new RegExp(`^\\s*${LEADER}\\S`, "u");

/** Years 1500–2039, not inside a longer number or a date ("1/2020"); global, for counting. */
export const YEAR_RE = /(?<![\d/.])(?:1[5-9]\d\d|20[0-3]\d)[a-z]?(?![\d])/g;
export const DOI_RE = /\b(?:doi|DOI|Doi)\b|\b10\.\d{4,9}\//;
export const URL_RE = /https?:\/\/|www\.|\.(?:org|com|edu|gov)\b/i;
export const PAGE_RANGE_RE = /\bpp?\.\s*\d|\b\d{1,5}\s*[–—~～-]\s*\d{1,5}\b/;
export const VOL_ISSUE_RE = /\b\d{1,4}\s?\(\s?\d{1,4}(?:\s?[–-]\s?\d{1,4})?\s?\)|\b(?:[Vv]ol|VOL|[Nn]o|NO|[Nn]r|[Bb]d|[Jj]g|[Hh]eft)\.\s?\d/;
export const IN_EDS_RE = /(?:^|[\s.,])In:?\s+[A-ZÀ-Þ]|\(eds?\.?\)|\beds?\.\s|\bed\. by\b|\(Hrsg\.?\)|\bHrsg\.|\(Hg\.?\)|\(dir\.\)|\(coord\.\)/;
export const VENUE_RE = /\b(?:Press|Publishers?|Publishing|Verlag|Journal|Review|Proceedings|Conference|Symposium|Quarterly|Annals|Bulletin|Letters|Transactions|Editions|Éditions|Books|Zeitschrift|Revista|Revue|Rivista|Thesis|Dissertation|Working Paper|Report|Univ\.|University)\b/;

const PROSE_WORDS = new Set([
    "we", "our", "us", "is", "are", "was", "were", "that", "this", "these", "those", "which",
    "has", "have", "had", "be", "been", "being", "can", "could", "may", "might", "will",
    "would", "should", "not", "it", "its", "there", "however", "thus", "therefore", "also",
    "because", "when", "while", "than", "here", "such", "they", "their", "he", "she", "his",
    "her", "you", "i", "do", "does", "did", "if", "but", "so", "very", "more", "most",
]);
const NON_ASCII_WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const NON_ASCII_LETTER_RE = /\p{L}/u;

export function isWhitespace(code: number): boolean {
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

export interface TextCounts {
    /** Whitespace-separated words with a letter or digit. */
    words: number;
    /** Words of running prose ("is", "this", "we", …). */
    prose: number;
    /** Words that start with an uppercase letter. */
    capWords: number;
    digits: number;
    commas: number;
    periods: number;
    semicolons: number;
    /** Initials: "J." after a non-letter, before a space, comma, hyphen, capital or the end. */
    initials: number;
}

/**
 * Word and character counts of a text in one pass: words (whitespace-split,
 * leading punctuation dropped), capitalized and prose words, digits, commas,
 * periods, semicolons, and initials.
 */
export function scanText(text: string): TextCounts {
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
 * Text patterns are read from at most this many leading and trailing
 * characters. Reference entries are shorter; for long body paragraphs this
 * bounds the cost without changing what the features say about them.
 */
const SCAN_HEAD = 800;
const SCAN_TAIL = 400;

/** The part of a (trimmed) text that patterns are read from (`SCAN_HEAD` + `SCAN_TAIL`). */
export function scanWindow(full: string): string {
    return full.length > SCAN_HEAD + SCAN_TAIL ? `${full.slice(0, SCAN_HEAD)} ${full.slice(-SCAN_TAIL)}` : full;
}

/** Non-whitespace UTF-16 code units of a text. */
export function visibleChars(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (!isWhitespace(text.charCodeAt(i))) n++;
    return n;
}

/** Matches of a global regular expression in a text. */
export function countMatches(re: RegExp, text: string): number {
    re.lastIndex = 0;
    let n = 0;
    while (re.exec(text) !== null) n++;
    return n;
}

/** Leading list number of a text ("[12]", "12.", "(12)", "12 Smith"), or null. */
export function leadingNumber(text: string): number | null {
    let i = 0;
    while (i < text.length && isWhitespace(text.charCodeAt(i))) i++;
    const code = text.charCodeAt(i);
    if (code !== 91 && code !== 40 && !(code >= 48 && code <= 57)) return null;
    const m = /^\s*(?:\[(\d{1,4})\]|\((\d{1,4})\)|(\d{1,4})[.)](?!\d)|(\d{1,4})\s+(?=\p{Lu}))/u.exec(text);
    if (!m) return null;
    return Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/**
 * What may open a heading before its words: a bullet or ornament ("■ References"),
 * a section number ("6.", "IV") or a letter enumerator ("G. Bibliography").
 */
const HEADING_LEAD = String.raw`(?:[^\p{L}\p{N}\s]{1,3}\s*)?(?:[\dIVX]+\.?\s*|\p{Lu}[.)]\s*)?`;

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

/** An item as the heading tests read it. */
export interface HeadingCandidate {
    /** The paragraph detector read the item as a heading. */
    header: boolean;
    text: string;
}

/** Whether the item reads as a reference-list heading. */
export function isReferenceHeading(item: HeadingCandidate): boolean {
    const text = item.text.trim();
    if (text.length > 60) return false;
    if (REF_HEADING_RE.test(text)) return true;
    return item.header && AMBIGUOUS_HEADING_RE.test(text);
}

/** Whether the item reads as a notes-section heading. */
export function isNotesHeading(item: HeadingCandidate): boolean {
    const text = item.text.trim();
    return text.length <= 40 && NOTES_HEADING_RE.test(text);
}
