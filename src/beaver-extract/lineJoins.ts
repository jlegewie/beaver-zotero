/**
 * How two lines of a paragraph join: with a space, directly, or with a
 * line-end hyphen removed. Shared by the structured text builder
 * (`buildParagraphText`) and the markdown / heading text (`joinLines`), so
 * both read a line break the same way. Used when the PDF schema preset turns
 * on `lineJoins`; earlier schemas keep `decideLineBreakHyphen`.
 */

/** Soft hyphen (U+00AD): a hyphenation point, visible only at a line break. */
export const SOFT_HYPHEN = "\u00AD";

/**
 * `"space"`: the lines join with a space. `"join"`: the previous line's last
 * character (a hyphen) is dropped and the lines join directly. `"glue"`: the
 * lines join directly, characters unchanged.
 */
export type LineJoin = "space" | "join" | "glue";

/**
 * Document text the hyphen decision consults: the hyphenated compounds of
 * its lines (`"broken-windows"`, as consecutive pairs, lowercased), which
 * is the set itself, and the words, compound left parts and compound right
 * parts. Words and parts leave out both halves of words split at a line end,
 * which would otherwise vouch for themselves.
 */
export class LineJoinVocabulary extends Set<string> {
    /**
     * Compounds spelled with the Unicode hyphen (U+2010), as consecutive
     * pairs with "-". Kept apart from the set itself, which PDF schema 4
     * reads with ASCII hyphens only.
     */
    readonly unicodeHyphenCompounds = new Set<string>();
    readonly words = new Set<string>();
    readonly compoundLefts = new Set<string>();
    readonly compoundRights = new Set<string>();

    // Derived from `words`, rebuilt when it has grown since.
    private sortedWords: string[] = [];
    private sortedWordCount = -1;
    private german = false;
    private germanWordCount = -1;

    /** Some word of the document starts with `prefix` (lowercase). */
    hasWordStartingWith(prefix: string): boolean {
        if (this.sortedWordCount !== this.words.size) {
            this.sortedWords = [...this.words].sort();
            this.sortedWordCount = this.words.size;
        }
        const sorted = this.sortedWords;
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] < prefix) lo = mid + 1;
            else hi = mid;
        }
        return lo < sorted.length && sorted[lo].startsWith(prefix);
    }

    /**
     * The document reads as German prose: it uses more of the common German
     * function words than of the English ones, and at least a few.
     */
    get readsAsGerman(): boolean {
        if (this.germanWordCount !== this.words.size) {
            const english = ENGLISH_FUNCTION_WORDS.filter((word) => this.words.has(word)).length;
            const german = GERMAN_FUNCTION_WORDS.filter((word) => this.words.has(word)).length;
            this.german = german >= 6 && german > english;
            this.germanWordCount = this.words.size;
        }
        return this.german;
    }
}

/**
 * Function words of running prose, rare in reference titles, so a document
 * citing work in the other language still reads as its own.
 */
const ENGLISH_FUNCTION_WORDS = [
    "that", "which", "were", "these", "have", "been", "this", "there", "their", "also", "would", "should",
    "however", "between", "than", "such", "other", "into", "because", "when",
];
const GERMAN_FUNCTION_WORDS = [
    "nicht", "sich", "wird", "werden", "wurde", "wurden", "sind", "auch", "oder", "dass", "kann", "diese",
    "dieser", "zwischen", "durch", "sowie", "jedoch", "einer", "einem", "nach",
];

const WORD_RE = /\p{L}+/gu;
/** A hyphenated compound of letters (ASCII hyphen-minus), as `collectHyphenatedCompounds` reads them. */
const COMPOUND_RE = /\p{L}+(?:-\p{L}+)+/gu;
/**
 * A compound whose parts count as compound parts: hyphen-minus or Unicode
 * hyphen, not glued to digits or letters ("β-Gen" in the gene name
 * "HNF1β-Gen" is no compound).
 */
const COMPOUND_PARTS_RE = /(?<![\p{L}\p{N}])\p{L}+(?:[-\u2010]\p{L}+)+(?![\p{L}\p{N}])/gu;
/** A line-end hyphen: ASCII hyphen-minus, Unicode hyphen, or soft hyphen. */
const LINE_END_HYPHEN_RE = /[-\u2010\u00AD]$/u;

/**
 * Add a block's lines (in reading order) to `vocabulary`. Compounds come from
 * every line, so the set matches `collectHyphenatedCompounds` (PDF schema 4
 * reads it); words and compound parts skip the last word of a line ending in
 * a hyphen and the first word of the line after it, and read a word with a
 * soft hyphen inside it ("air" + U+00AD + "port") as the whole word.
 */
export function addBlockToVocabulary(lines: readonly string[], vocabulary: LineJoinVocabulary): void {
    let afterHyphen = false;
    for (const line of lines) {
        const tokens = line.split(/\s+/u).filter(Boolean);
        const endsWithHyphen = LINE_END_HYPHEN_RE.test(line.trimEnd());
        for (let t = 0; t < tokens.length; t++) {
            const whole = !(afterHyphen && t === 0) && !(endsWithHyphen && t === tokens.length - 1);
            const token = tokens[t].split(SOFT_HYPHEN).join("");
            if (!/[-\u2010]/u.test(token)) {
                if (whole) for (const word of token.matchAll(WORD_RE)) vocabulary.words.add(word[0].toLowerCase());
                continue;
            }
            // The raw token, as `collectHyphenatedCompounds` reads it.
            for (const match of tokens[t].matchAll(COMPOUND_RE)) {
                const parts = match[0].toLowerCase().split("-");
                for (let i = 0; i + 1 < parts.length; i++) vocabulary.add(`${parts[i]}-${parts[i + 1]}`);
            }
            for (const match of token.includes("\u2010") ? token.matchAll(COMPOUND_PARTS_RE) : []) {
                const parts = match[0].toLowerCase().split(/[-\u2010]/u);
                for (let i = 0; i + 1 < parts.length; i++) vocabulary.unicodeHyphenCompounds.add(`${parts[i]}-${parts[i + 1]}`);
            }
            if (!whole) continue;
            for (const match of token.matchAll(COMPOUND_PARTS_RE)) {
                const parts = match[0].toLowerCase().split(/[-\u2010]/u);
                for (let i = 0; i + 1 < parts.length; i++) {
                    vocabulary.compoundLefts.add(parts[i]);
                    vocabulary.compoundRights.add(parts[i + 1]);
                }
            }
            for (const word of token.matchAll(WORD_RE)) vocabulary.words.add(word[0].toLowerCase());
        }
        if (tokens.length > 0) afterHyphen = endsWithHyphen;
    }
}

const URL_HOST_RE =
    /[a-z0-9-]+\.(?:com|org|net|edu|gov|mil|int|io|co|info|biz|us|uk|ca|eu|de|fr|au|nl|jp|cn|in|ru|br|gov\.uk|ac\.uk)\b/i;
const FILE_EXT_RE =
    /\.(?:pdf|html?|php|aspx?|jsp|xml|json|csv|tsv|txt|docx?|xlsx?|pptx?|zip|tar|gz|png|jpe?g|gif|svg)\b/i;

/**
 * True when a whitespace-delimited token is a URL / email / DOI / filesystem
 * path, where hyphens are literal and a line break inside it is not a word
 * space. A bare `/` between letters ("and/or") is not a path.
 */
export function isUrlishToken(token: string): boolean {
    return (
        /:\/\//.test(token) ||
        /^mailto:/i.test(token) ||
        /@[a-z0-9.-]+\.[a-z]{2,}/i.test(token) ||
        /\bwww\./i.test(token) ||
        URL_HOST_RE.test(token) ||
        FILE_EXT_RE.test(token) ||
        /\b10\.\d{4,}\//.test(token) ||
        /^doi:/i.test(token) ||
        /^\.{0,2}\//.test(token) ||
        /\\/.test(token)
    );
}

/**
 * Coordinating words after a suspended hyphen ("high- and low-stress"): the
 * hyphen and the space both stay.
 */
const SUSPENDED_BEFORE = new Set(["and", "or", "nor", "und", "oder", "sowie", "bzw", "et", "ou"]);

/** Short elements of hyphenated phrases ("state-of-the-art", "day-to-day", "cause-and-effect"). */
const COMPOUND_CONNECTORS = new Set([
    "a", "an", "and", "as", "at", "be", "by", "de", "for", "in", "la", "le", "of", "on", "or", "per",
    "the", "to", "und", "vs",
]);

/** Endings a line break splits off a word ("cross-ing", "self-ish", "four-teen"). */
const SUFFIXES = new Set([
    "ing", "ed", "er", "ers", "est", "ly", "ness", "less", "ful", "ish", "hood", "ship", "ment", "ments",
    "able", "ible", "ity", "ities", "ism", "ist", "ists", "ize", "ized", "ization", "ion", "ions", "al",
    "ally", "ance", "ence", "ous", "ive", "ic", "ics", "y", "s", "es", "ary", "ery", "teen", "ty", "fold",
    "ward", "wards", "wise",
]);

/** Left parts of closed compounds of two words ("further-more", "with-out", "there-fore"). */
const CLOSED_COMPOUND_LEFTS = new Set([
    "further", "with", "some", "there", "where", "here", "how", "when", "what", "who", "every", "any",
    "no", "never", "the", "none", "them", "him", "her", "it", "your", "our", "my", "in", "on", "up",
    "down", "after", "before", "be", "to", "for", "an",
]);

/**
 * Left parts whose compounds keep their hyphen ("self-", "well-", "cross-",
 * "high-", "twenty-"). Bound prefixes that also form closed words ("inter",
 * "pre", "multi", "out", "off") are left out, and so is "ten", the first
 * syllable of many words ("ten-sion", "ten-dency"). The closed words these
 * left parts do form are `CLOSED_AFTER_PREFIX`.
 */
const HYPHEN_PREFIXES = new Set([
    "self", "well", "cross", "non", "high", "low", "long", "short", "best", "worst", "half", "full",
    "single", "double", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "first", "second",
    "third", "real", "ever",
]);

/**
 * Bound prefixes: one starts many compounds and many closed words, so it
 * appearing as a word or a compound's left part elsewhere says nothing.
 */
const BOUND_PREFIXES = new Set([
    "inter", "intra", "pre", "post", "multi", "co", "anti", "semi", "sub", "super", "over", "under",
    "re", "de", "un", "non", "dis", "mis", "trans", "micro", "macro", "meta", "neuro", "bio", "geo",
    "auto", "hyper", "hypo", "poly", "mono", "pro", "counter", "extra", "ultra", "infra", "tele",
    "pseudo", "quasi", "socio", "psycho", "per", "out", "off", "bi",
]);

/**
 * Right parts that form closed words only ("else-where", "which-ever",
 * "outer-most", "worth-while"), unlike words that also end hyphenated
 * compounds ("wrong-way", "inside-out").
 */
const CLOSED_COMPOUND_RIGHTS = new Set(["where", "ever", "most", "while"]);

/**
 * Endings that make a word of a hyphen prefix, with their inflections
 * ("four-th", "short-en", "short-ening", "low-ered", "real-istic").
 */
const PREFIX_WORD_ENDING_RE = /^(?:ths?|ties|en(?:s|ed|ing|ings|er|ers)?|er(?:ed|ing)|ages?|istic|istically)$/u;

/** Number words a numeral prefix forms ("four-teenth", "nine-tieth"); after "low-", "teens" is a word. */
const NUMBER_WORD_PREFIXES = new Set(["four", "six", "seven", "eight", "nine"]);
const NUMBER_WORD_ENDING_RE = /^(?:teens?|teenths?|tieths?)$/u;

/**
 * Closed words (by their stem) that a hyphen prefix forms ("high-" + "light",
 * "non-" + "sense"), joined like any word when a line break splits them there.
 */
const CLOSED_AFTER_PREFIX = [
    "nonsens", "nonchalan", "selfsame", "wellspring", "wellhead", "crossroad", "crosswalk", "crossword",
    "crossbow", "crossfire", "crossbar", "crossbreed", "highlight", "highway", "highland", "highbrow",
    "lowland", "lowercase", "longitud", "longhand", "shortcoming", "shortcut", "shortfall", "shorthand",
    "shortlist", "bestow", "bestseller", "halfway", "halftone", "halfhearted", "singleton", "singlet",
    "doublet", "twosome", "foursome", "firsthand", "evergreen", "evermore", "realm",
];

/**
 * A word split at a line-end hyphen, `left` + `right`: is the hyphen part of
 * the word ("keep"), a hyphenation point ("join"), or a suspended hyphen
 * ("suspend": "high- and low-stress")? Evidence in order: the document's
 * own spelling (the hyphenated or the joined form elsewhere), the word's
 * shape (a further hyphen, a capitalized right part, an acronym on the left),
 * then common prefixes and suffixes, then (outside German text, unless the
 * parts form a closed word) whether both parts are words or compound parts
 * the document uses. Without evidence, the hyphen joins: most
 * line-end hyphens are hyphenation points.
 */
export function decideSplitWord(
    leftToken: string,
    left: string,
    right: string,
    rightRest: string,
    vocabulary: LineJoinVocabulary | ReadonlySet<string> | undefined,
    capitalsText = false,
): "keep" | "join" | "suspend" {
    const l = left.toLowerCase();
    const r = right.toLowerCase();
    const vocab = vocabulary instanceof LineJoinVocabulary ? vocabulary : undefined;
    if (vocabulary?.has(`${l}-${r}`)) return "keep";
    if (vocab?.words.has(l + r)) return "join";
    // A Unicode-hyphen spelling counts unless the document also writes the
    // word closed ("on‐line" once, "online" throughout).
    if (vocab?.unicodeHyphenCompounds.has(`${l}-${r}`)) return "keep";
    // One hyphen of several, next to a whole element ("state-of-" + "the-art",
    // "analog-" + "to-digital", "T-FAP-" + "mediated"). A break inside an
    // element ("self-determina-" + "tion") is a hyphenation point. In
    // all-capitals text every part looks like an acronym, so capitals are
    // no evidence of an element there ("SELF-DETERMINA-" + "TION"), and a
    // connector is matched in lowercase ("STATE-OF-"). Elsewhere a
    // capitalized syllable is no connector ("US-An-" + "leihen").
    const leftRest = leftToken.slice(0, leftToken.length - left.length - 1);
    const isElement = (part: string) =>
        COMPOUND_CONNECTORS.has(capitalsText ? part.toLowerCase() : part) ||
        (!capitalsText && /^\p{Lu}+$/u.test(part)) ||
        (part.length >= 3 && vocab?.words.has(part.toLowerCase()) === true);
    if ((/[-‐]/u.test(leftRest) && isElement(left)) || (/^[-‐]/u.test(rightRest) && isElement(right))) return "keep";
    // Before the capitals tests: an acronym can open a suspended compound
    // ("DNA- and RNA-based").
    if (SUSPENDED_BEFORE.has(r) && !/^[\p{L}\-‐]/u.test(rightRest)) return "suspend";
    // In all-capitals text ("INTER-" + "NATIONAL LAW") capitals say nothing
    // about the word.
    if (!capitalsText) {
        // A capitalized right part: a name or a capitalized compound
        // ("Montoliu-Gaya", "non-European", "F&I-Politik"); a word split
        // mid-way continues in lowercase.
        if (/^\p{Lu}/u.test(right) && left !== left.toUpperCase()) return "keep";
        // An acronym or a single capital on the left ("HIV-infected",
        // "C-terminus", "siRNA-H19"), but not a name with an inner capital
        // ("McKen-" + "zie").
        if (/^\p{Lu}$/u.test(left) || (/\p{Lu}/u.test(left.slice(1)) && !/^\p{Lu}\p{Ll}+\p{Lu}\p{Ll}+$/u.test(left))) {
            return "keep";
        }
    }
    if (SUFFIXES.has(r) || CLOSED_COMPOUND_LEFTS.has(l)) return "join";
    // A prefix keeps its hyphen before a word-sized right part, unless the
    // two form a closed word.
    if (HYPHEN_PREFIXES.has(l)) {
        if (
            r.length < 3 ||
            PREFIX_WORD_ENDING_RE.test(r) ||
            (NUMBER_WORD_PREFIXES.has(l) && NUMBER_WORD_ENDING_RE.test(r)) ||
            CLOSED_AFTER_PREFIX.some((stem) => (l + r).startsWith(stem))
        ) {
            return "join";
        }
        return "keep";
    }
    // A bound prefix keeps its hyphen before the vowel it ends with
    // ("meta-analysis", "anti-inflammatory", "re-enter").
    if (BOUND_PREFIXES.has(l) && /[aei]$/u.test(l) && r.startsWith(l[l.length - 1])) return "keep";
    // Words and compound parts vouch for a compound, but not in German
    // text, which writes compounds of words closed ("unter-" + "stellen",
    // "Literatur-" + "geschichte"), nor when the parts form a closed word:
    // a right part that only closes words ("else-" + "where"), or the
    // joined word with another ending, written closed elsewhere in the
    // document ("cor-" + "related" beside "correlation", "methyl-" +
    // "ations" beside "methylation"). The stem leaves off two letters and
    // keeps at least three of the right part, so a word that merely shares
    // the start ("maneater" for "man-" + "eating") is no evidence.
    const stem = (l + r).slice(0, -2);
    if (
        vocab &&
        !vocab.readsAsGerman &&
        !CLOSED_COMPOUND_RIGHTS.has(r) &&
        !(stem.length >= l.length + 3 && vocab.hasWordStartingWith(stem))
    ) {
        // A bound prefix starts closed words ("under-" + "standing"),
        // whatever compounds the document builds elsewhere.
        const bound = BOUND_PREFIXES.has(l);
        if ((vocab.compoundLefts.has(l) && !bound && l.length >= 3) || (vocab.compoundRights.has(r) && !bound)) return "keep";
        if (!bound && l.length >= 3 && r.length >= 3 && vocab.words.has(l) && vocab.words.has(r)) return "keep";
    }
    return "join";
}

/** Han, kana, CJK punctuation and fullwidth forms: scripts written without word spaces. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF01-\uFF60\u30FC]/u;
/** Fullwidth Latin letters and digits. */
const FULLWIDTH_ALNUM_RE = /[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/u;
const FULLWIDTH_DIGIT_RE = /[\uFF10-\uFF19]/u;
/** Two fullwidth words with a space (ASCII or ideographic) between them. */
const SPACED_FULLWIDTH_RE =
    /[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A][\uFF0C\uFF0E\uFF1A\uFF1B]?[ \u3000][\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;

/** Letters around a line break are capitals (a heading or label set in capitals). */
function isCapitalsText(text: string): boolean {
    const letters = text.match(/\p{L}/gu) ?? [];
    if (letters.length < 6) return false;
    return letters.filter((ch) => /\p{Lu}/u.test(ch)).length >= 0.9 * letters.length;
}

/** A domain or file extension that ends a URL ("org.", "cn)", "pdf"). */
const URL_TAIL_RE =
    /^(?:com|org|net|edu|gov|mil|int|io|co|info|biz|us|uk|ca|eu|de|fr|au|nl|jp|cn|in|ru|br|ch|at|it|es|se|no|dk|fi|be|pl|kr|tw|hk|sg|nz|za|pdf|html?|php|aspx?|jsp|xml|json|csv|txt|docx?|xlsx?|pptx?|zip|gz|png|jpe?g|gif|svg)\b/i;

/**
 * A token that reads as part of a URL or DOI ("j.cell.2021",
 * "policy/sp2016"), not a word. A domain or file ending ("org)", "pdf") counts
 * only after the period it follows in `prevToken`: after a "/", "in" or "at"
 * is a word of the sentence.
 */
function isUrlText(token: string, prevToken: string): boolean {
    const core = token.replace(/[.,;:)\]〉>"'”’]+$/u, "");
    return /[./\d_\-#?=&%:~]/u.test(core) || (prevToken.endsWith(".") && URL_TAIL_RE.test(core));
}

/**
 * A URL / DOI token that the line break cuts, so the next line continues it.
 * `next` is the next line's text, from `nextToken`.
 */
function continuesUrl(prevToken: string, nextToken: string, next = ""): boolean {
    // "https:" + "//github.com/…"
    if (/^[a-z][a-z0-9+.-]*:$/iu.test(prevToken) && nextToken.startsWith("//")) return true;
    if (prevToken.length < 4 || !isUrlishToken(prevToken)) return false;
    if (/^[/.?&=#_~%]/u.test(nextToken)) return true;
    if (!/[/:._\-?=&#~%]$/u.test(prevToken) || /\)[.:]$/u.test(prevToken)) return false;
    // A sentence after a URL that ends it starts with a capital. After a
    // "/", a plain word that more lowercase words follow
    // ("https://example.org/" + "using the supplied credentials") or a label
    // ("e4/" + "doi: 10.2196/…") goes on with the sentence, while a path's
    // last segment ends the line or meets punctuation ("mouseland/" +
    // "cellpose. Scripts", "infolit.be/" + "edudoc), which").
    if (/^\p{Lu}\p{Ll}/u.test(nextToken)) return false;
    if (
        prevToken.endsWith("/") &&
        (/^\p{L}+:$/u.test(nextToken) || (/^\p{Ll}+$/u.test(nextToken) && /^\S+\s+\p{Ll}/u.test(next)))
    ) {
        return false;
    }
    // After a period, the URL goes on only into more URL ("j." +
    // "learninstruc.2006.09.001", "www." + "congressionalbills.org"), not
    // into a word of the sentence.
    return !prevToken.endsWith(".") || /[./\d_\-#?=&]/u.test(nextToken) || URL_TAIL_RE.test(nextToken);
}

/**
 * How the line `prev` joins the line `next` of the same paragraph:
 *
 *  - a soft hyphen at the end of `prev` is a hyphenation point: drop it, no
 *    space ("Kosten" + soft hyphen + "verhalten");
 *  - a hyphen after a letter, before a letter, follows `decideSplitWord`;
 *  - a URL or DOI cut by the break continues without a space
 *    ("https:" + "//github.com", "10.1016/j." + "learninstruc");
 *  - a number range cut after its dash continues without a space
 *    ("19:422–" + "33", "4.32%–" + "13.28%");
 *  - Chinese and Japanese text has no word spaces;
 *  - Korean text breaks between words or inside a word; the PDF keeps the
 *    space after the last word of a line that breaks between words, so a
 *    line without one continues its word;
 *  - anything else joins with a space.
 */
/**
 * The text ends and the next starts with Chinese or Japanese script, which
 * has no word spaces (whole code points: Han extensions lie outside the BMP).
 * Fullwidth letters and digits break anywhere in CJK typesetting
 * ("研究于２０" + "２２年", "Ｓ" + "ＮＳの利用"), but a phrase that spaces its
 * fullwidth words breaks between words, except inside a number: the PDF
 * sets a space at the end of the line ("Ｊｏｕｒｎａｌ\u3000" + "ｏｆ"), or
 * the lines space their words ("Ｔｈｅ Ｉｍｐａｃｔ ｏｆ Ｆｉｎａｎｃｅ" + "ｏｎ").
 */
export function joinsWithoutSpace(prev: string, next: string): boolean {
    const p = prev.trimEnd();
    const n = next.trimStart();
    if (!p || !n) return false;
    const last = Array.from(p.slice(-2)).pop()!;
    const first = String.fromCodePoint(n.codePointAt(0)!);
    if (!CJK_RE.test(last) || !CJK_RE.test(first)) return false;
    if (!FULLWIDTH_ALNUM_RE.test(last) || !FULLWIDTH_ALNUM_RE.test(first)) return true;
    if (FULLWIDTH_DIGIT_RE.test(last) && FULLWIDTH_DIGIT_RE.test(first)) return true;
    return !/\s$/u.test(prev) && !SPACED_FULLWIDTH_RE.test(p) && !SPACED_FULLWIDTH_RE.test(n);
}

export function decideLineJoin(
    prev: string,
    next: string,
    vocabulary?: LineJoinVocabulary | ReadonlySet<string>,
): LineJoin {
    const p = prev.trimEnd();
    const n = next.trimStart();
    if (!p || !n) return "space";
    if (p.endsWith(SOFT_HYPHEN)) return "join";
    const prevToken = /\S+$/u.exec(p)?.[0] ?? "";
    const nextToken = /^\S+/u.exec(n)?.[0] ?? "";
    const endsWithHyphen = p.endsWith("-") || p.endsWith("\u2010");
    const split = endsWithHyphen ? /(\p{L}+)[-\u2010]$/u.exec(p) : null;
    const rightWord = split ? /^(\p{L}+)(\S*)/u.exec(n) : null;
    if (split && rightWord) {
        if (isUrlishToken(prevToken) || isUrlishToken(nextToken)) return "glue";
        const decision = decideSplitWord(
            prevToken,
            split[1],
            rightWord[1],
            rightWord[2],
            vocabulary,
            isCapitalsText(p.slice(-40) + n.slice(0, 40)),
        );
        return decision === "join" ? "join" : decision === "keep" ? "glue" : "space";
    }
    // After whitespace the PDF set at the line end, the URL may be complete
    // ("https://example.org/ " + "for more"): it goes on only into a token
    // that is itself URL text, or after a "-" or "_" no URL ends with. Many
    // PDFs end every line with a space, so the space alone does not end it.
    if (continuesUrl(prevToken, nextToken, n) && (!/\s$/u.test(prev) || /[-_]$/u.test(prevToken) || isUrlText(nextToken, prevToken))) {
        return "glue";
    }
    if (/[\p{N}%][-\u2010\u2013]$/u.test(prevToken) && /^\p{N}/u.test(nextToken)) return "glue";
    if (joinsWithoutSpace(prev, next)) return "glue";
    const last = Array.from(p.slice(-2)).pop()!;
    const first = String.fromCodePoint(n.codePointAt(0)!);
    if (HANGUL_RE.test(last) && HANGUL_RE.test(first) && !/\s$/u.test(prev)) return "glue";
    return "space";
}

/**
 * Join a paragraph's line texts with `decideLineJoin`, and remove soft
 * hyphens inside lines (they only mark where a word may break).
 */
export function joinLineTexts(lines: readonly string[], vocabulary?: LineJoinVocabulary | ReadonlySet<string>): string {
    let text = lines[0] ?? "";
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const join = decideLineJoin(lines[i - 1], line, vocabulary);
        if (join === "space") text = `${text.trimEnd()} ${line.trimStart()}`;
        else if (join === "join") text = text.trimEnd().slice(0, -1) + line.trimStart();
        else text = text.trimEnd() + line.trimStart();
    }
    return text.split(SOFT_HYPHEN).join("").replace(/\s+/gu, " ").trim();
}
