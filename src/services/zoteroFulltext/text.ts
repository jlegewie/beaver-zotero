/**
 * Pure text helpers for full-text search on Zotero's own index: query-term
 * construction, the FTS5 expressions sent to Zotero's content tables, page-bounded
 * passages cut from extracted text, and in-memory BM25 over those passages.
 *
 * Nothing here touches Zotero, so it runs unchanged in unit tests. Normalization
 * mirrors `Zotero.Utilities.Internal.normalizeForSearch`, the form Zotero indexes,
 * so query terms match its tokens.
 */

/** Characters NFKD leaves alone that Zotero folds when indexing. */
const FOLD_MAP: Record<string, string> = {
    'ø': 'o', 'œ': 'oe', 'æ': 'ae', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'ı': 'i', '⁄': '/',
};

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
/** Word tokens as FTS5's unicode61 tokenizer produces them from normalized text. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Query terms without agent keywords; with keywords the expanded expression is larger. */
export const MAX_QUERY_TERMS = 16;
export const MAX_EXPANDED_TERMS = 32;

/** Passage packing target, in characters (lines are packed until the next would pass it). */
export const PASSAGE_TARGET_CHARS = 1300;
/** A single line longer than this is split at sentence or word boundaries. */
export const PASSAGE_MAX_CHARS = 2000;

/**
 * Short multilingual stopword list (function and question words). Dropping them
 * keeps natural-language queries from ranking on filler words; when a query has
 * nothing else, its tokens are kept.
 */
export const STOPWORDS: ReadonlySet<string> = new Set((
    'a an the and or of in on at to for from by with without into onto over under about as is are was were be been '
    + 'being do does did done has have had having it its this that these those there their them they he she we you i not no '
    + 'nor but if then than so such which what who whom whose when where why how whether can could may might must shall should '
    + 'will would also very more most less least many much some any each every all both either neither other another same own '
    + 'only just one two between among through during before after above below up down out off again further once here '
    + 'der die das den dem des ein eine einer eines und oder nicht ist sind war mit von zu im auf fur le la les un une et ou '
    + 'est sont du de en au aux el los las y es son del por para con '
    // Words agents use to phrase a search request rather than its topic
    + 'paper papers article articles find finds regarding discuss discusses say says mention mentions'
).split(/\s+/));

/** Fold text the way Zotero normalizes indexed content and search terms. */
export function normalizeForSearch(text: string): string {
    if (!text) return '';
    return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[øœæłđðþßı⁄]/g, (c) => FOLD_MAP[c] ?? c)
        .replace(/[‘’‚‛′]/g, "'")
        .replace(/[“”„‟″]/g, '"')
        .replace(/[‐‑‒–—―−]/g, '-')
        .normalize('NFC');
}

export function hasCjk(text: string): boolean {
    return CJK_CHAR_RE.test(text);
}

/** Overlapping 2-grams of a CJK run; a single character stays itself. */
function cjkBigrams(run: string): string[] {
    const chars = Array.from(run);
    if (chars.length < 2) return chars;
    const out: string[] = [];
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    return out;
}

/**
 * Tokens of already-normalized text: word tokens for non-CJK scripts and 2-grams
 * for CJK runs, matching how Zotero indexes the two scripts.
 */
export function tokenizeNormalized(normalized: string): string[] {
    const tokens: string[] = [];
    for (const match of normalized.matchAll(WORD_RE)) {
        const word = match[0];
        if (!CJK_CHAR_RE.test(word)) {
            tokens.push(word);
            continue;
        }
        let last = 0;
        for (const run of word.matchAll(CJK_RUN_RE)) {
            const start = run.index ?? 0;
            if (start > last) tokens.push(word.slice(last, start));
            tokens.push(...cjkBigrams(run[0]));
            last = start + run[0].length;
        }
        if (last < word.length) tokens.push(word.slice(last));
    }
    return tokens;
}

export function tokenize(text: string): string[] {
    return tokenizeNormalized(normalizeForSearch(text));
}

/** One OR-ed search term: a single token or a phrase of adjacent tokens. */
export interface QueryTerm {
    /** Normalized surface form: tokens joined by spaces, or the CJK run itself. */
    text: string;
    /**
     * The spelling as written (case, diacritics), words joined by spaces. Zotero's
     * own search normalizes its input to match its index, which on Zotero 7–9
     * keeps diacritics, so it must receive this rather than the folded form.
     */
    original: string;
    /** Normalized tokens; more than one means a phrase. */
    tokens: string[];
    /** Pure CJK terms match Zotero's 2-gram table; everything else its word table. */
    cjk: boolean;
    source: 'phrase' | 'query' | 'keyword';
}

export interface BuiltQuery {
    terms: QueryTerm[];
    /** Terms dropped by the cap, so the caller can report truncation. */
    truncated: number;
}

/** Words as written: letters, digits and combining marks. */
const RAW_WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

interface Word {
    raw: string;
    tokens: string[];
}

function wordsOf(segment: string): Word[] {
    return [...segment.matchAll(RAW_WORD_RE)]
        .map((match) => ({ raw: match[0], tokens: tokenizeNormalized(normalizeForSearch(match[0])) }))
        .filter((word) => word.tokens.length > 0);
}

function wordTerm(words: Word[], source: QueryTerm['source']): QueryTerm {
    const tokens = words.flatMap((word) => word.tokens);
    return { text: tokens.join(' '), original: words.map((word) => word.raw).join(' '), tokens, cjk: false, source };
}

/**
 * Terms of a piece of text: CJK runs become 2-gram terms, the rest one phrase
 * per non-CJK stretch, or one term per word with `split`.
 */
function termsFromText(text: string, source: QueryTerm['source'], split = false): QueryTerm[] {
    const raw = text.normalize('NFC');
    const out: QueryTerm[] = [];
    const pushWords = (segment: string) => {
        const words = wordsOf(segment);
        if (!words.length) return;
        if (split) for (const word of words) out.push(wordTerm([word], source));
        else out.push(wordTerm(words, source));
    };
    let last = 0;
    for (const run of raw.matchAll(CJK_RUN_RE)) {
        const start = run.index ?? 0;
        pushWords(raw.slice(last, start));
        const normalized = normalizeForSearch(run[0]);
        out.push({ text: normalized, original: run[0], tokens: cjkBigrams(normalized), cjk: true, source });
        last = start + run[0].length;
    }
    pushWords(raw.slice(last));
    return out;
}

/** Terms in order, without repeats (same table, same normalized text). */
function uniqueTerms(terms: QueryTerm[]): QueryTerm[] {
    const seen = new Set<string>();
    return terms.filter((term) => {
        const key = `${term.cjk ? 'c' : 'w'}:${term.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Build the OR-ed term list for a search.
 *
 * - User-quoted phrases in `query` stay phrases.
 * - Other query tokens become single-token terms, stopwords dropped unless
 *   nothing else is left.
 * - Each keyword becomes one term: a multi-word keyword is a phrase, a single
 *   stopword is dropped.
 *
 * The query contributes at most 16 terms; with keywords, the de-duplicated
 * list is capped at 32.
 */
export function buildQueryTerms(query: string, keywords: readonly string[] = []): BuiltQuery {
    const items: QueryTerm[] = [];
    const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const phrase of phrases) items.push(...termsFromText(phrase, 'phrase'));

    const rest = query.replace(/"[^"]*"/g, ' ');
    // Unquoted query text is OR-ed word by word; CJK runs stay one 2-gram phrase.
    const queryTokens = termsFromText(rest, 'query', true);
    const content = queryTokens.filter((term) => term.tokens.length > 1 || !STOPWORDS.has(term.tokens[0]));
    items.push(...(content.length ? content : queryTokens));
    // The query's own distinct terms never take more than the plain-query cap, so keywords always fit.
    const queryItems = uniqueTerms(items);
    const queryOverflow = Math.max(0, queryItems.length - MAX_QUERY_TERMS);
    items.splice(0, items.length, ...queryItems.slice(0, MAX_QUERY_TERMS));

    for (const keyword of keywords) {
        for (const term of termsFromText(keyword, 'keyword')) {
            if (term.tokens.length === 1 && STOPWORDS.has(term.tokens[0])) continue;
            items.push(term);
        }
    }

    const unique = uniqueTerms(items);
    const cap = keywords.length ? MAX_EXPANDED_TERMS : MAX_QUERY_TERMS;
    return { terms: unique.slice(0, cap), truncated: queryOverflow + Math.max(0, unique.length - cap) };
}

/** FTS5 phrase literal for a term. Tokens are letters/digits only, so quoting is safe. */
export function ftsPhrase(term: QueryTerm): string {
    return `"${term.tokens.join(' ').replace(/"/g, '""')}"`;
}

/** OR-expression over the word-table or CJK-table terms; empty when there are none. */
export function ftsExpression(terms: readonly QueryTerm[], cjk: boolean): string {
    return terms.filter((term) => term.cjk === cjk).map(ftsPhrase).join(' OR ');
}

/** Display form of a term (phrases quoted), for logs and the tool result. */
export function termDisplay(term: QueryTerm): string {
    return term.tokens.length > 1 && !term.cjk ? `"${term.text}"` : term.text;
}

// ---------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------

export interface TextPassage {
    /** 0-based page in the source text, or null for unpaged text (EPUB, snapshots). */
    pageIndex: number | null;
    text: string;
    /** The passage sits in a reference list (bibliography). */
    reference?: boolean;
}

/** A line that is only a bibliography heading, in the languages Beaver's users write in. */
const REFERENCE_HEADING_RE = new RegExp(
    '^(?:[0-9ivx]+\\.?\\s*)?(?:references?|bibliography|works cited|literature cited|cited literature|reference list'
    + '|literatur|literaturverzeichnis|quellenverzeichnis|bibliographie|références|referencias|bibliografía|bibliografia'
    + '|referências|riferimenti bibliografici|参考文献|引用文献|참고문헌)\\s*:?$',
    'i',
);
/** A short line that starts back matter after the references (appendices, supplements). */
const BACK_MATTER_RE = /^(?:appendix|appendices|supplementary|supplemental|anhang|annexe|online appendix)\b/i;

/** Split an over-long line at sentence ends, then spaces, into pieces of at most `max` chars. */
function splitLongLine(line: string, max: number): string[] {
    const pieces: string[] = [];
    let rest = line;
    while (rest.length > max) {
        const window = rest.slice(0, max);
        let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('。'));
        if (cut < max / 2) cut = window.lastIndexOf(' ');
        if (cut < max / 2) cut = max - 1;
        pieces.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
    }
    if (rest.trim()) pieces.push(rest.trim());
    return pieces.filter(Boolean);
}

/**
 * Cut passages from extracted text.
 *
 * With `paged`, the text is split into pages on form feeds (how Zotero stores
 * PDF text) and passages never cross a page, so each keeps its page number.
 * Lines are packed until the next would pass the target size. Passages after a
 * bibliography heading are marked as references until back matter starts.
 */
export function cutPassages(text: string, paged: boolean): TextPassage[] {
    const pages = paged ? text.split('\f') : [text];
    const passages: TextPassage[] = [];
    let inReferences = false;
    pages.forEach((page, index) => {
        const pageIndex = paged ? index : null;
        let buffer: string[] = [];
        let size = 0;
        const flush = () => {
            if (buffer.length) {
                passages.push({ pageIndex, text: buffer.join('\n'), ...(inReferences ? { reference: true } : {}) });
            }
            buffer = [];
            size = 0;
        };
        for (const raw of page.split('\n')) {
            const line = raw.replace(/\s+/g, ' ').trim();
            if (!line) continue;
            const startsReferences = !inReferences && REFERENCE_HEADING_RE.test(line);
            const endsReferences = inReferences && line.length < 60 && BACK_MATTER_RE.test(line);
            if (startsReferences || endsReferences) {
                flush();
                inReferences = startsReferences;
            }
            for (const piece of line.length > PASSAGE_MAX_CHARS ? splitLongLine(line, PASSAGE_TARGET_CHARS) : [line]) {
                if (buffer.length && size + piece.length > PASSAGE_TARGET_CHARS) flush();
                buffer.push(piece);
                size += piece.length;
            }
        }
        flush();
    });
    return passages;
}

/**
 * Whether form feeds split `text` into exactly `pageCount` pages. Zotero's
 * cache has no page breaks for text synced from Zotero's servers, and a
 * mismatch means page numbers cannot be trusted.
 */
export function hasPageBreaksFor(text: string, pageCount: number | null): boolean {
    if (!pageCount) return false;
    let breaks = 0;
    for (let i = text.indexOf('\f'); i !== -1; i = text.indexOf('\f', i + 1)) breaks++;
    return breaks + 1 === pageCount;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text of an HTML document: scripts and styles dropped, block elements on their own lines. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
            if (entity[0] === '#') {
                const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
                return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
            }
            return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
        });
}

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Occurrences of `term` in a token array (phrases match adjacent tokens). */
export function termFrequency(tokens: readonly string[], term: QueryTerm): number {
    const [first, ...rest] = term.tokens;
    let count = 0;
    for (let i = 0; i <= tokens.length - term.tokens.length; i++) {
        if (tokens[i] !== first) continue;
        let match = true;
        for (let j = 0; j < rest.length; j++) {
            if (tokens[i + 1 + j] !== rest[j]) { match = false; break; }
        }
        if (match) count++;
    }
    return count;
}

/**
 * BM25 score of each document (token array) for the OR of `terms`, with IDF from
 * these documents only. Uses FTS5's formula, including its floor for non-positive
 * IDF, so ranking matches what an in-memory FTS5 table would give.
 */
export function bm25Scores(docs: readonly (readonly string[])[], terms: readonly QueryTerm[]): number[] {
    const n = docs.length;
    if (!n || !terms.length) return docs.map(() => 0);
    const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / n || 1;
    const tf = terms.map((term) => docs.map((doc) => termFrequency(doc, term)));
    const idf = tf.map((freqs) => {
        const df = freqs.filter((f) => f > 0).length;
        const value = Math.log((n - df + 0.5) / (df + 0.5));
        return value > 0 ? value : 1e-6;
    });
    return docs.map((doc, d) => {
        let score = 0;
        for (let t = 0; t < terms.length; t++) {
            const f = tf[t][d];
            if (!f) continue;
            score += idf[t] * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * doc.length / avgdl));
        }
        return score;
    });
}

/** BM25 weight of reference-list passages: they quote cited titles, so they match topics without discussing them. */
export const REFERENCE_WEIGHT = 0.3;

/**
 * Pick the passages to return: BM25 matches first, best first (reference-list
 * passages down-weighted), then — when fewer than `limit` matched — unmatched
 * body passages taken round-robin across documents, so the reranker can still
 * find a passage worded differently from the query.
 */
export function selectPassages(
    candidates: readonly { passages: readonly { text: string; reference?: boolean }[] }[],
    terms: readonly QueryTerm[],
    limit: number,
): { candidate: number; passage: number; score: number }[] {
    const flat: { candidate: number; passage: number }[] = [];
    candidates.forEach((candidate, c) => candidate.passages.forEach((_, p) => flat.push({ candidate: c, passage: p })));
    const scores = bm25Scores(flat.map(({ candidate, passage }) => tokenize(candidates[candidate].passages[passage].text)), terms);
    const isReference = (entry: { candidate: number; passage: number }) =>
        !!candidates[entry.candidate].passages[entry.passage].reference;
    const matched = flat
        .map((entry, i) => ({ ...entry, score: scores[i] * (isReference(entry) ? REFERENCE_WEIGHT : 1) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.candidate - b.candidate || a.passage - b.passage)
        .slice(0, limit);
    if (matched.length >= limit) return matched;
    const taken = new Set(matched.map((entry) => `${entry.candidate}:${entry.passage}`));
    const fill: { candidate: number; passage: number; score: number }[] = [];
    const longest = Math.max(0, ...candidates.map((candidate) => candidate.passages.length));
    for (let p = 0; p < longest && matched.length + fill.length < limit; p++) {
        for (let c = 0; c < candidates.length && matched.length + fill.length < limit; c++) {
            if (p < candidates[c].passages.length && !taken.has(`${c}:${p}`) && !candidates[c].passages[p].reference) {
                fill.push({ candidate: c, passage: p, score: 0 });
            }
        }
    }
    return [...matched, ...fill];
}
