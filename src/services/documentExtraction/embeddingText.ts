import type { StructuredDocument } from '@beaver/agent-core/extract/schema';
import type { DomDocument } from '@beaver/agent-core/extract/document/dom/schema';

/**
 * Derive a short, topic-representative text for semantic-search embeddings from
 * an extracted document (PDF, EPUB or web snapshot).
 *
 * The text is meant for items without a usable abstract and for standalone
 * attachments. It prefers the document's own abstract or summary, falls back to
 * its opening prose, and skips the front matter that dominates real first pages:
 * repository cover pages, author and affiliation blocks, license and download
 * notices, tables of contents and article metadata.
 *
 * Pure function over the extraction schemas: no Zotero, DOM or I/O access.
 */

export type EmbeddingTextSource =
    | {
          contentKind: 'pdf';
          document: StructuredDocument;
          /** PDF Info dictionary title, used as a title candidate after a plausibility check. */
          pdfTitle?: string | null;
      }
    | { contentKind: 'epub' | 'snapshot'; document: DomDocument };

export interface EmbeddingTextOptions {
    /** Bibliographic title when known (e.g. the parent item's title). Takes precedence over derived titles. */
    title?: string | null;
    /** Budget for the derived body text, in characters. */
    maxBodyChars?: number;
    /** Budget for the keyword line, in characters. */
    maxKeywordChars?: number;
    /**
     * PDF only: content pages scanned, not counting skipped cover and front-matter
     * pages. Defaults to 5, or 10 for documents longer than 60 pages.
     */
    maxPages?: number;
}

export type EmbeddingBodySource = 'abstract' | 'opening' | 'outline' | 'none';
export type EmbeddingTitleSource = 'provided' | 'pdf_metadata' | 'document';

export interface EmbeddingText {
    /** Text to embed: title, keyword line and body, separated by blank lines. */
    text: string;
    title: string | null;
    titleSource: EmbeddingTitleSource | null;
    keywords: string | null;
    /** Derived body without title or keywords; empty when nothing usable was found. */
    body: string;
    bodySource: EmbeddingBodySource;
}

const DEFAULTS = {
    maxBodyChars: 4000,
    maxKeywordChars: 300,
    maxPages: 5,
};

/** PDF page count above which the page budget doubles. */
const LONG_DOCUMENT_PAGES = 60;
/** PDF front matter does not count against the page budget, but scanning stops after this many budgets. */
const MAX_SKIPPED_PAGE_FACTOR = 4;
/** DOM documents have no pages; scanning stops after this many blocks. */
const MAX_DOM_BLOCKS = 1500;
/** Blocks inspected after a label-only abstract heading while looking for its text. */
const ABSTRACT_LOOKAHEAD = 12;
/** Minimum size of a derived abstract; shorter matches are treated as false positives. */
const MIN_ABSTRACT_UNITS = 30;
/** Prose (in word-equivalents) after which an abstract label is no longer trusted. */
const MAX_PROSE_BEFORE_ABSTRACT = 500;
/** Budget for the heading outline used when a document has no running prose. */
const MAX_OUTLINE_CHARS = 800;
/** Size of the first block that starts the opening-text fallback. */
const MIN_OPENING_START_UNITS = 40;
/** Minimum size of later blocks appended to the opening text. */
const MIN_OPENING_CONTINUE_UNITS = 15;

type BlockKind = 'heading' | 'text' | 'list' | 'other';

interface Block {
    kind: BlockKind;
    /** Inside a front-matter region (contents, acknowledgments, …); see `markFrontMatterRegions`. */
    frontMatter?: boolean;
    text: string;
    /** Page index (PDF) or section index (DOM). */
    unit: number;
    /** Length in word-equivalents; see `lengthUnits`. */
    units: number;
    /** PDF only: item rect (top-left origin) and page size. */
    bbox?: [number, number, number, number];
    pageWidth?: number;
    pageHeight?: number;
}

// ---------------------------------------------------------------------------
// Text measurement and normalization
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Length in word-equivalents. CJK scripts have no spaces, so each CJK character
 * counts as half a word (roughly the token ratio of Chinese vs. English text).
 */
function lengthUnits(text: string): number {
    const cjk = text.match(CJK_CHAR)?.length ?? 0;
    const latin = text.replace(CJK_CHAR, ' ').match(WORD)?.length ?? 0;
    return latin + Math.ceil(cjk / 2);
}

function normalizeText(text: string): string {
    return text
        .replace(/^#+\s*/, '')
        .replace(/^[|•·▪■◆►]\s*/, '')
        // EPUB print-page markers rendered into the text ("Page 12 →").
        .replace(/\bPage [\divxlcdm]+ →\s*/gi, '')
        .replace(/\u00ad|\u200b|\u200c|\u200d|\ufeff/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Characters between two printed line numbers: at most about one line of text.
 * Short lines (headings, paragraph ends) can be much shorter.
 */
const LINE_NUMBER_GAP = { min: 3, max: 200 };
/**
 * Consecutive line-spaced integers on one page needed to treat them as printed
 * line numbers. Line numbering runs down the whole page; prose that happens to
 * mention a few consecutive counts ("12 … 13 … 14 participants") stays well below.
 */
const MIN_LINE_NUMBER_RUN = 8;

/**
 * Find manuscript line numbers that PDF extraction interleaved with the text of
 * a page ("… potential to help combat the 13 effects of climate change …").
 *
 * A number belongs to line numbering only as part of a page-wide run of at
 * least `MIN_LINE_NUMBER_RUN` consecutive integers, each at most about one line
 * of text after the previous one. The run may continue across items
 * (paragraphs) and skip over other numbers in the text. Year-like values never
 * qualify.
 *
 * Returns, per item, the start offsets of the numbers to remove.
 */
function findLineNumbers(texts: string[]): Array<Set<number>> {
    const found: Array<{ item: number; index: number; value: number; pos: number; posEnd: number }> = [];
    let offset = 0;
    texts.forEach((text, item) => {
        for (const m of text.matchAll(/(?<=^|\s)(\d{1,4})(?=\s|$)/g)) {
            const pos = offset + m.index!;
            found.push({ item, index: m.index!, value: Number(m[1]), pos, posEnd: pos + m[1].length });
        }
        offset += text.length + 1;
    });
    const drop = texts.map(() => new Set<number>());
    if (found.length < MIN_LINE_NUMBER_RUN) return drop;

    // Longest run ending at each number, linking to an earlier number with the
    // previous value at most about one line before it.
    const run = new Array<number>(found.length).fill(0);
    const prev = new Array<number>(found.length).fill(-1);
    for (let j = 0; j < found.length; j++) {
        const { value, pos } = found[j];
        if (value >= 1800 && value <= 2100) continue;
        run[j] = 1;
        for (let i = j - 1; i >= 0 && pos - found[i].posEnd <= LINE_NUMBER_GAP.max; i--) {
            const gap = pos - found[i].posEnd;
            if (found[i].value === value - 1 && gap >= LINE_NUMBER_GAP.min && run[i] > 0 && run[i] + 1 > run[j]) {
                run[j] = run[i] + 1;
                prev[j] = i;
            }
        }
    }
    const marked = new Set<number>();
    for (let j = 0; j < found.length; j++) {
        if (run[j] < MIN_LINE_NUMBER_RUN) continue;
        for (let k = j; k >= 0 && !marked.has(k); k = prev[k]) marked.add(k);
    }
    for (const k of marked) drop[found[k].item].add(found[k].index);
    return drop;
}

function removeNumbersAt(text: string, starts: Set<number>): string {
    if (!starts.size) return text;
    return text.replace(/(?<=^|\s)\d{1,4}(?=\s|$)/g, (match, index: number) => (starts.has(index) ? '' : match));
}

/**
 * Decode a numeric character reference. Anything that is not a Unicode scalar
 * value (NUL, surrogates, above U+10FFFF) is left as written, so a malformed
 * entity in PDF metadata cannot abort extraction.
 */
function decodeCodePoint(entity: string, codePoint: number): string {
    const valid = Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : entity;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (entity, hex) => decodeCodePoint(entity, parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (entity, dec) => decodeCodePoint(entity, Number(dec)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function truncateAtSentence(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const cut = text.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    if (end > maxChars * 0.6) return cut.slice(0, end + 1);
    const space = cut.lastIndexOf(' ');
    return space > maxChars * 0.6 ? cut.slice(0, space) : cut;
}

// ---------------------------------------------------------------------------
// Block classification
// ---------------------------------------------------------------------------

/**
 * Notices that identify a page or block as front matter rather than content.
 * One match is enough for short blocks; long prose needs two (a paper may
 * legitimately mention "copyright" or "license").
 */
const BOILERPLATE = new RegExp(
    [
        'jstor', 'your use of th(e|is)', 'terms (and|&) conditions', 'terms of use', 'all rights reserved',
        'creative commons', 'licen[cs]ed under', '\\bcc[ -]by\\b', 'open access (article|journal)',
        'this (content|article|document|pdf) (was )?downloaded', 'downloaded (from|by)', 'heinonline',
        'see discussions, stats', 'to cite this article', 'to link to this article', 'published online',
        'full terms', 'reprints? (and|&) permissions?', 'for permissions', 'copyright', '©',
        'project gutenberg', 'electronic copy available', 'academic repository', 'version of record',
        'accepted manuscript', 'author manuscript', 'not certified by peer review', 'preprint',
        'corresponding author', 'correspondence', 'contributed equally', 'equal contribution',
        'e-?mail( address)?:', 'orcid', 'received:? \\d', 'accepted:? \\d',
        'article history', 'available online', 'funding', 'conflicts? of interest', 'competing interests?',
        'acknowledg', 'we thank', 'disclaimer', 'has made every effort', 'isbn', 'issn', 'doi:', 'doi\\.org',
        'https?://', 'www\\.', '\\bis (a|an) (\\w+ ){0,3}(publisher|press)\\b', 'abbreviations:',
        'do(es)? not necessarily reflect', 'citations are provided as a general guideline', 'provided by:',
        'articles you may be interested in', '(check|click) for updates', 'alle rechte vorbehalten',
        'anspruch auf vollständigkeit', 'tous droits réservés', 'todos los derechos reservados',
        'library of congress', 'cataloging[- ]in[- ]publication', 'british library', 'printed in', 'first published',
        'no part of this (publication|book)', 'nihil obstat', 'imprimatur', 'is a department of the university',
        'rely on their own experience', 'in (loving )?memory of', 'dedicated to', 'à la mémoire', 'grateful to',
        'skip to (main )?(content|article|navigation)', 'log ?in', 'sign in', 'subscribe', 'advanced search',
        'search this journal', 'email this article', 'alert me when', 'cookies?', 'privacy policy',
        'non-?commercial', 'personal use', 'publishing agreement', 'intentionally left blank',
        'made this article openly available', 'permanent link',
    ].join('|'),
    'gi',
);

/** Page markers of repository and aggregator cover sheets. */
const COVER_MARKER =
    /your use of the jstor archive|see discussions, stats,? and author profiles|to cite this article:|heinonline|content downloaded\/printed from|academic repository|this document is downloaded from|electronic copy available at|downloaded from (http|www)|citations are provided as a general guideline|bluebook \d+(st|nd|rd|th) ed|citation for published version|take down policy|general rights|link to publication|document version|research portal|repository istituzionale|research repository|previously published works|publication date:|made this article openly available/i;

const AFFILIATION =
    /(?<!\p{L})(universi|department|dept\.|institut|school of|college|laborator|hospital|faculty|facult[ée]|facultad|centre|center for|centro|academy|graduate program|head of)/iu;

const TOC_LINE = /(\.\s?){4,}|…{2,}|_{4,}/;

/**
 * Labels in scripts that separate words must end at a word boundary ("Abstract",
 * not "Abstraction"); CJK labels are followed directly by text.
 */
const wordLabel = (pattern: string) => `${pattern}(?![\\p{L}\\p{N}])`;

const ABSTRACT_LABEL = new RegExp(
    '^[\\d\\W]{0,3}?[\\[［【〔〈《(（]?\\s*(' +
        [
            ...[
                'a\\s?b\\s?s\\s?t\\s?r\\s?a\\s?c\\s?t', 'executive summary', 'summary', 'synopsis',
                'résumé', 'resume', 'resumen', 'resumo', 'riassunto', 'zusammenfassung', 'kurzfassung',
                'samenvatting', 'sammanfattning', 'sammendrag', 'streszczenie', 'аннотация', 'реферат',
                'özet', 'tiivistelmä', 'abstrakt', 'sažetak', 'περίληψη',
            ].map(wordLabel),
            '内容摘要', '内容提要', '摘\\s*要', '要\\s*旨', '抄\\s*録', '概\\s*要', '요\\s*약', '초\\s*록',
        ].join('|') +
        ')\\s*[\\]］】〕〉》)）]?\\s*([:：.。—–-]\\s*)?',
    'iu',
);

const KEYWORD_LABEL = new RegExp(
    '^[\\d\\W]{0,3}?[\\[［【〔〈《(（]?\\s*(' +
        [
            ...[
                'key\\s?-?words?', 'index terms', 'mots[- ]cl[ée]s', 'schlüsselwörter', 'schlagwörter',
                'palabras clave', 'parole chiave', 'palavras[- ]chave', 'trefwoorden', 'słowa kluczowe',
                'ключевые слова', 'anahtar kelimeler',
            ].map(wordLabel),
            '关\\s*键\\s*词', '關\\s*鍵\\s*詞', 'キーワード', '주제어', '핵심어',
        ].join('|') +
        ')\\s*[\\]］】〕〉》)）]?\\s*([:：.。—–-]\\s*)?',
    'iu',
);

/** Sub-headings inside structured abstracts; they do not end the abstract. */
const STRUCTURED_ABSTRACT_PART =
    /^(background|objectives?|aims?|purpose|context|importance|methods?|design|setting|participants|interventions?|measurements?|main outcomes?( and measures?)?|results?|findings|conclusions?( and relevance)?|interpretation|significance|implications)\b/i;

function boilerplateHits(text: string): number {
    return text.match(BOILERPLATE)?.length ?? 0;
}

function isBoilerplate(block: Block): boolean {
    const hits = boilerplateHits(block.text);
    return hits >= 2 || (hits >= 1 && block.units < 80);
}

/** Contents run into one paragraph: "… Introduction 242 2. Basic notions 244 3. …". */
const TOC_ENTRY = /\p{L}\s+\d{1,4}\s+(\d+(\.\d+)*\.?|[IVX]+\.)\s+\p{Lu}/gu;

function isTocLine(text: string): boolean {
    return TOC_LINE.test(text) || (text.match(TOC_ENTRY)?.length ?? 0) >= 3;
}

/** Share of Latin-script words that start with an uppercase letter. */
function capitalizedRatio(text: string): number {
    const words = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
    const latin = words.filter((w) => /^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(w) && w.length > 1);
    if (latin.length < 8) return 0;
    return latin.filter((w) => /^[A-ZÀ-ÖØ-Þ]/.test(w)).length / latin.length;
}

/** Author lists, affiliations and similar name-heavy blocks. */
function isNameOrAffiliationBlock(text: string, units: number): boolean {
    const capitalized = capitalizedRatio(text);
    if (capitalized > 0.7) return true;
    return AFFILIATION.test(text) && units < 120 && capitalized > 0.45;
}

/**
 * Whether a block reads as running prose: enough letters, sentence punctuation
 * and not dominated by names, numbers or table-of-contents leaders.
 */
function isProse(block: Block): boolean {
    const { text, units } = block;
    if (block.kind !== 'text' && block.kind !== 'list') return false;
    if (isTocLine(text)) return false;
    const nonSpace = text.replace(/\s/g, '');
    if (!nonSpace) return false;
    const letters = nonSpace.match(/\p{L}/gu)?.length ?? 0;
    const digits = nonSpace.match(/\p{N}/gu)?.length ?? 0;
    if (letters / nonSpace.length < 0.6 || digits / nonSpace.length > 0.2) return false;
    if (!/[.!?。！？;；:؟।]/.test(text) && units >= 25) return false;
    // Long runs without sentence ends are lists (contents, outlines, navigation).
    if (units >= 60 && countSentenceEnds(text) < units / 80) return false;
    if (isNameOrAffiliationBlock(text, units) || isGarbled(text)) return false;
    return true;
}

/**
 * Sentence boundaries: terminal punctuation after a lowercase or uncased letter,
 * followed by a capital, an uncased letter or the end. Requiring lowercase in
 * cased scripts skips abbreviations and initials ("J. Smith"); uncased scripts
 * (Hangul, Arabic, Hebrew, Devanagari) have no such signal, so any letter counts.
 * CJK full stops and the Devanagari danda need no following space.
 */
function countSentenceEnds(text: string): number {
    return text.match(
        /[\p{Ll}\p{Lo}][.!?؟]["'”’)]?(\s+["“(]?[\p{Lu}\p{Lo}]|\s*$)|[。！？।]/gu,
    )?.length ?? 0;
}

/**
 * Text from PDFs with broken font encodings ("3UlÀJXUDWLYH 3ROLWLN …"): real
 * words rarely switch from lowercase to uppercase mid-word.
 */
function isGarbled(text: string): boolean {
    const words = text.match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    if (words.length < 8) return false;
    const odd = words.filter((w) => /\p{Ll}\p{Lu}|\p{N}\p{L}+\p{N}/u.test(w) || /^\p{N}\p{Lu}{2}/u.test(w));
    return odd.length / words.length > 0.25;
}

// ---------------------------------------------------------------------------
// Normalization into blocks
// ---------------------------------------------------------------------------

function pdfBlocks(document: StructuredDocument, maxPages: number): { blocks: Block[]; skipUnits: Set<number> } {
    const blocks: Block[] = [];
    const skipUnits = new Set<number>();
    let contentPages = 0;
    for (const page of document.pages) {
        if (contentPages >= maxPages) break;
        const pageBlocks: Block[] = [];
        const textItems = page.items.filter(
            (item): item is typeof item & { text: string } => 'text' in item && typeof item.text === 'string',
        );
        const lineNumbers = findLineNumbers(textItems.map((item) => item.text));
        for (const [n, item] of textItems.entries()) {
            // Captions, footnotes and formulas describe local details, not the document.
            const kind: BlockKind =
                item.kind === 'section_header' ? 'heading'
                : item.kind === 'text' ? 'text'
                : item.kind === 'list_item' ? 'list'
                : 'other';
            const text = normalizeText(removeNumbersAt(item.text, lineNumbers[n]));
            if (!text) continue;
            pageBlocks.push({
                kind, text, unit: page.index, units: lengthUnits(text),
                bbox: item.bbox, pageWidth: page.width, pageHeight: page.height,
            });
        }
        markFrontMatterRegions(pageBlocks, true);
        if (isCoverPage(pageBlocks) || isFrontMatterUnit(pageBlocks)) {
            skipUnits.add(page.index);
        } else if (pageBlocks.some((b) => b.units > 0 && !b.frontMatter)) {
            contentPages++;
        }
        blocks.push(...pageBlocks);
        if (page.index + 1 >= maxPages * MAX_SKIPPED_PAGE_FACTOR) break;
    }
    return { blocks, skipUnits };
}

/** Front or back matter made of short entries: contents, indexes, reference lists. */
const LIST_MATTER_HEADING =
    /^(contents|table of contents|inhalt(sverzeichnis)?|sommaire|table des matières|índice|indice|abbreviations|list of (figures|tables|illustrations|maps|abbreviations|contributors)|tables and figures|figures and tables|index|bibliography|references)\s*[:.]?$/i;

/** Front or back matter written as prose: acknowledgments, notices, author notes. */
const PROSE_MATTER_HEADING =
    /^(acknowledge?ments?|dedication|copyright|imprint|colophon|about the (authors?|editors?|publisher|series|book)|also by .*|other (books|titles) .*|praise for .*|series (editor|page|information|list)s?|notes on contributors|contributors|title page|half[- ]?title( page)?|epigraph)\s*[:.]?$/i;

/** Markers of bibliographic entries: "(editor)", "(Oxford, 1702)", "pp. 12", "vol. 3". */
const REFERENCE_MARKER =
    /\((eds?|editors?|trans|hrsg)\.?\)|\([^()]*\b(1[5-9]|20)\d{2}[a-z]?\)|\bpp?\.\s?\d|\bvol\.\s?\d/i;

/**
 * A bibliographic entry rather than a paragraph: a reference marker in a single
 * "sentence". Prose citing "(Blinder, 1973)" runs over several sentences.
 */
function isReferenceEntry(text: string): boolean {
    return REFERENCE_MARKER.test(text) && countSentenceEnds(text) <= 1;
}

/** Headings that begin the content of a book or report. */
const CONTENT_START_HEADING =
    /^((\d+|[ivx]+)\.?\s+)?(introduction|einleitung|introducción|introduzione|introdução|preface|prefacio|vorwort|avant-propos|foreword|prologue|chapter\b|part\b)/i;

/**
 * Mark front- and back-matter regions so body text skips only them, keeping
 * content that shares a page or section with a table of contents:
 * - a list-type heading (contents, index, references) covers its entries, up to
 *   the first real paragraph or a content heading ("Introduction") followed by
 *   prose; entries set as headings or written as references do not end it;
 * - a prose-type heading (acknowledgments, contributors, copyright) at the start
 *   of a PDF page or EPUB section (`atUnitStart`) covers the rest of the unit
 *   unless a content heading followed by prose begins the content; elsewhere it
 *   covers up to the next heading.
 */
function markFrontMatterRegions(blocks: Block[], atUnitStart: boolean): void {
    let region: 'none' | 'list' | 'unit' | 'prose' = 'none';
    let seen = 0;
    const beginsContent = (i: number) =>
        blocks[i].kind === 'heading' && blocks[i].units <= 8 && CONTENT_START_HEADING.test(blocks[i].text)
        && blocks.slice(i + 1, i + 4).some((next) => isProse(next) && next.units >= MIN_OPENING_CONTINUE_UNITS);
    for (const [i, b] of blocks.entries()) {
        if (b.units === 0) continue;
        seen++;
        if (b.units <= 8 && LIST_MATTER_HEADING.test(b.text)) {
            region = 'list';
        } else if (b.units <= 8 && PROSE_MATTER_HEADING.test(b.text)) {
            region = atUnitStart && seen <= 3 ? 'unit' : 'prose';
        } else if (region === 'list') {
            const paragraph = isProse(b) && b.units >= MIN_OPENING_CONTINUE_UNITS && !isReferenceEntry(b.text);
            if (beginsContent(i) || paragraph) region = 'none';
        } else if (region === 'unit') {
            if (beginsContent(i)) region = 'none';
        } else if (region === 'prose') {
            if (b.kind === 'heading') region = 'none';
        }
        if (region !== 'none') b.frontMatter = true;
    }
}

/**
 * Whole units of front matter in books and reports: pages or EPUB sections that
 * consist mostly of notices (copyright, cataloging) or read as a table of
 * contents. Not applied to snapshots, whose single section is the whole page.
 */
function isFrontMatterUnit(blocks: Block[]): boolean {
    const content = blocks.filter((b) => b.units > 0);
    if (content.length === 0) return false;
    const total = content.reduce((sum, b) => sum + b.units, 0);
    const notices = content.filter((b) => isBoilerplate(b)).reduce((sum, b) => sum + b.units, 0);
    if (total >= 20 && notices / total >= 0.5) return true;
    const tocLines = content.filter((b) => isTocLine(b.text) || (b.units <= 15 && /\s\d{1,4}$/.test(b.text))).length;
    return content.length >= 6 && tocLines / content.length >= 0.5;
}

/**
 * A repository or aggregator cover sheet: carries a cover marker and no prose
 * beyond the notices themselves. Such pages still provide title candidates but
 * are skipped for body text and do not count against the page budget.
 */
function isCoverPage(blocks: Block[]): boolean {
    if (!blocks.some((b) => COVER_MARKER.test(b.text))) return false;
    if (blocks.some((b) => ABSTRACT_LABEL.test(b.text) && b.kind === 'heading')) return false;
    const proseUnits = blocks
        .filter((b) => isProse(b) && !isBoilerplate(b))
        .reduce((sum, b) => sum + b.units, 0);
    return proseUnits < 60;
}

function domBlocks(document: DomDocument, contentKind: 'epub' | 'snapshot'): { blocks: Block[]; skipUnits: Set<number> } {
    const blocks: Block[] = [];
    const skipUnits = new Set<number>();
    for (const section of document.sections) {
        const start = blocks.length;
        for (const item of section.items) {
            if (blocks.length >= MAX_DOM_BLOCKS) break;
            if (typeof item.text !== 'string') continue;
            const kind: BlockKind =
                item.kind === 'section_header' ? 'heading'
                : item.kind === 'text' ? 'text'
                : item.kind === 'list_item' ? 'list'
                : 'other';
            const text = normalizeText(item.text);
            if (!text) continue;
            blocks.push({ kind, text, unit: section.index, units: lengthUnits(text) });
        }
        const sectionBlocks = blocks.slice(start);
        markFrontMatterRegions(sectionBlocks, contentKind === 'epub');
        if (contentKind === 'epub' && isFrontMatterUnit(sectionBlocks)) skipUnits.add(section.index);
        if (blocks.length >= MAX_DOM_BLOCKS) break;
    }
    return { blocks, skipUnits };
}

// ---------------------------------------------------------------------------
// Abstract and keywords
// ---------------------------------------------------------------------------

interface LabelMatch {
    /** Text after the label; empty for a label-only block. */
    rest: string;
}

function matchLabel(block: Block, label: RegExp): LabelMatch | null {
    if (isTocLine(block.text)) return null;
    const m = label.exec(block.text);
    if (!m) return null;
    const rest = block.text.slice(m[0].length).trim();
    const hasSeparator = !!m[2] || /[\]］】〕〉》)）]/.test(m[0]);
    if (!rest) return { rest: '' };
    // "Summary statistics show…" is prose, not a label: inline labels need a
    // separator unless the block is a heading or the label is unambiguous.
    const unambiguous = /^[\d\W]{0,3}?(a\s?b\s?s\s?t\s?r\s?a\s?c\s?t(?![\p{L}\p{N}])|摘|内容|关|關|キー|要|抄)/iu.test(block.text);
    if (!hasSeparator && !unambiguous && block.kind !== 'heading') return null;
    // A heading that merely starts with the label ("Summary of findings") is a section title.
    if (block.kind === 'heading' && lengthUnits(rest) > 3 && !hasSeparator) return null;
    return { rest };
}

function isMetadataBlock(block: Block): boolean {
    if (block.units >= 40) return false;
    return isBoilerplate(block)
        || KEYWORD_LABEL.test(block.text)
        || /^(jel|msc|pacs)\b|classification|article (info|history)|a r t i c l e/i.test(block.text)
        || isNameOrAffiliationBlock(block.text, block.units);
}

function endsAbstract(block: Block): boolean {
    if (KEYWORD_LABEL.test(block.text)) return true;
    if (block.kind === 'heading') return !STRUCTURED_ABSTRACT_PART.test(block.text);
    return /^(\d+(\.\d+)*\.?|[ivx]+\.)?\s*(introduction|background)\b/i.test(block.text) && block.units < 6;
}

/** Whether a block is excluded from body text: a skipped unit or a front-matter region. */
function isSkipped(block: Block, skipUnits: Set<number>): boolean {
    return skipUnits.has(block.unit) || !!block.frontMatter;
}

function findAbstract(blocks: Block[], skipUnits: Set<number>, maxChars: number): string | null {
    let proseSeen = 0;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (isSkipped(block, skipUnits)) continue;
        // An abstract precedes the body. A label found after substantial prose
        // belongs to something else (a reporting checklist, a quoted paper, a
        // later chapter summary).
        if (proseSeen > MAX_PROSE_BEFORE_ABSTRACT) break;
        const label = matchLabel(block, ABSTRACT_LABEL);
        if (!label) {
            if (isProse(block) && !isBoilerplate(block)) proseSeen += block.units;
            continue;
        }

        const parts: string[] = [];
        let size = 0;
        if (label.rest && lengthUnits(label.rest) >= 3) {
            parts.push(label.rest);
            size += label.rest.length;
        }
        // Collect the abstract's paragraphs. Metadata blocks (article history,
        // keywords, affiliations) can sit between the label and its text in
        // two-column layouts, so they are skipped until the text starts.
        for (let j = i + 1; j < Math.min(blocks.length, i + 1 + ABSTRACT_LOOKAHEAD) && size < maxChars; j++) {
            const next = blocks[j];
            if (next.unit > block.unit + 1 || isSkipped(next, skipUnits)) break;
            if (parts.length > 0 && endsAbstract(next)) break;
            if (next.kind === 'heading') {
                if (STRUCTURED_ABSTRACT_PART.test(next.text) && next.units <= 6) {
                    parts.push(`${next.text.replace(/[:：]$/, '')}:`);
                    continue;
                }
                if (parts.length === 0) continue;
                break;
            }
            if (next.kind === 'other' || isMetadataBlock(next) || !isProse(next)) {
                continue;
            }
            parts.push(next.text);
            size += next.text.length;
        }
        const text = parts.join(' ').replace(/:\s*:/g, ':').trim();
        const units = lengthUnits(text);
        if (units >= MIN_ABSTRACT_UNITS && isProse({ kind: 'text', text, unit: block.unit, units })) {
            return truncateAtSentence(text, maxChars);
        }
    }
    return null;
}

function findKeywords(blocks: Block[], skipUnits: Set<number>, maxChars: number): string | null {
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (isSkipped(block, skipUnits)) continue;
        const label = matchLabel(block, KEYWORD_LABEL);
        if (!label) continue;
        let text = label.rest;
        // Label-only: keywords follow in the next short block(s).
        for (let j = i + 1; !text && j < Math.min(blocks.length, i + 3); j++) {
            if (blocks[j].units <= 40 && blocks[j].kind !== 'heading') text = blocks[j].text;
        }
        if (text && text.length <= maxChars * 2 && lengthUnits(text) <= 60) {
            return truncateAtSentence(text.replace(/\s*[;；,，·•]\s*/g, '; ').replace(/[.。]$/, ''), maxChars);
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Opening prose fallback
// ---------------------------------------------------------------------------

function isOpeningCandidate(block: Block, skipUnits: Set<number>, minUnits: number): boolean {
    return block.units >= minUnits && !isSkipped(block, skipUnits) && isProse(block) && !isBoilerplate(block);
}

/** A paragraph that starts lowercase continues text from elsewhere (another column or page). */
function isContinuation(block: Block): boolean {
    return /^\p{Ll}/u.test(block.text);
}

/**
 * Opening prose: from the first paragraph of the document, continuing in
 * reading order until the budget is filled.
 *
 * Multi-column first pages can put text from another column before the first
 * paragraph in reading order. When the title block is known and the first
 * paragraph is on its page, the start is the topmost paragraph below the title.
 */
function findOpening(blocks: Block[], skipUnits: Set<number>, maxChars: number, titleBlock: Block | null): string | null {
    const isStart = (b: Block) => isOpeningCandidate(b, skipUnits, MIN_OPENING_START_UNITS) && !isContinuation(b);
    let start = blocks.findIndex(isStart);
    if (start < 0) return null;
    if (titleBlock?.bbox && titleBlock.unit === blocks[start].unit) {
        const titleBottom = titleBlock.bbox[3];
        let best = -1;
        for (let i = start; i < blocks.length && blocks[i].unit === titleBlock.unit; i++) {
            const b = blocks[i];
            if (!b.bbox || b.bbox[1] < titleBottom - 2 || !isStart(b)) continue;
            if (best < 0 || b.bbox[1] < blocks[best].bbox![1]) best = i;
        }
        if (best >= 0) start = best;
    }
    const parts: string[] = [];
    let size = 0;
    for (let i = start; i < blocks.length && size < maxChars; i++) {
        if (!isOpeningCandidate(blocks[i], skipUnits, MIN_OPENING_CONTINUE_UNITS)) continue;
        parts.push(blocks[i].text);
        size += blocks[i].text.length + 1;
    }
    return truncateAtSentence(parts.join(' '), maxChars);
}

/**
 * Last resort for documents without running prose (slide decks, posters,
 * forms): the distinct headings and short text lines of the first pages.
 */
function findOutline(blocks: Block[], skipUnits: Set<number>, maxChars: number): string | null {
    const seen = new Set<string>();
    const parts: string[] = [];
    let size = 0;
    for (const block of blocks) {
        if (size >= maxChars) break;
        if (isSkipped(block, skipUnits) || block.kind === 'other' || block.units < 2) continue;
        if (isBoilerplate(block) || isTocLine(block.text) || isGarbled(block.text)) continue;
        if (isNameOrAffiliationBlock(block.text, block.units)) continue;
        const key = block.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(block.text.replace(/[.:;]$/, ''));
        size += block.text.length + 2;
    }
    return parts.length >= 3 ? truncateAtSentence(parts.join('. '), maxChars) : null;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const BAD_TITLE =
    /^(untitled|microsoft (word|powerpoint)|document\d*|title|paper|article|manuscript|slides?|presentation)\b|\.(pdf|docx?|pptx?|tex|indd|eps|qxd|dvi)\b|^[\w.-]+$|^\d[\d\s._-]*$|^doi:|\b\d+\.\.\d+$/i;

/** PDF Info titles are unreliable: keep one only if it looks like a title and appears in the text. */
function plausiblePdfTitle(title: string | null | undefined, blocks: Block[]): string | null {
    const t = title ? normalizeText(decodeEntities(title)) : '';
    if (!t || BAD_TITLE.test(t)) return null;
    const units = lengthUnits(t);
    if (units < 2 || units > 50) return null;
    const words = new Set((t.toLowerCase().match(/\p{L}{3,}/gu) ?? []));
    if (words.size === 0) return /[\u3400-\u9fff]/u.test(t) ? t : null;
    const haystack = blocks.slice(0, 200).map((b) => b.text.toLowerCase()).join(' ');
    let found = 0;
    for (const w of words) if (haystack.includes(w)) found++;
    return found / words.size >= 0.7 ? t : null;
}

const JOURNALISH =
    /^(open( access)?|article|review|research( article)?|original (article|research)|review article|report|letter|brief communication|resource|editorial|commentary|perspective|analysis|full length article|hhs public access|author manuscript|nih public access|contents|table of contents|inhalt|preface|foreword|copyright|special report|methodology( open access)?|research open access)$|journal|proceedings|volume|\bvol\.|issn|homepage|^special issue|^supplementary (materials?|information)|^annual review of|^conference on|symposium|open access$/i;

/** A bare personal name with an initial ("Stephen J. Giovannoni", "R. Marcon"). */
const PERSON_NAME = /^(?=.*\b\p{Lu}\.)(\p{Lu}[\p{Ll}'’-]+|\p{Lu}\.)(\s+(\p{Lu}[\p{Ll}'’-]+|\p{Lu}\.)){1,3}$/u;

/** Lowercase function words: present in title-cased titles, absent from author lists. */
const FUNCTION_WORD = /\s(of|the|in|on|for|to|with|from|by|at|an?|as|via|into|between|during|under|over|toward|towards|through)\s/i;

/** Author lists: capitalized names joined by separators, without function words. */
function isAuthorList(text: string): boolean {
    if (FUNCTION_WORD.test(` ${text} `)) return false;
    const separators = (text.match(/,|\s(and|&|und|et|y)\s/g) ?? []).length;
    const words = text.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
    const capitalized = words.filter((w) => /^\p{Lu}/u.test(w)).length;
    return separators >= 1 && words.length >= 3 && capitalized / words.length > 0.8;
}

/**
 * Author lines: capitalized names followed by affiliation markers and a
 * separator ("Garg1,2,", "Castelos*1", "Campo,1 Elaine"). Gene names in titles
 * ("Kif9 is …") are followed by words, not separators.
 */
const AUTHOR_MARKERS = /\p{Lu}[\p{Ll}'’-]+(?:[\d*†‡§]+(?:,\s?[\d*†‡§]+)*\s*(?:[,·&]|and\b|$)|,\d+\b)/u;

function isTitleCandidate(block: Block): boolean {
    if (block.kind !== 'heading' && block.kind !== 'text') return false;
    if (block.units < 2 || block.units > 40) return false;
    const t = block.text;
    if (JOURNALISH.test(t) || isBoilerplate(block) || ABSTRACT_LABEL.test(t) || KEYWORD_LABEL.test(t)) return false;
    if (isTocLine(t) || isGarbled(t) || /[:：]$/.test(t) || /\|/.test(t)) return false;
    if (AUTHOR_MARKERS.test(t) || AFFILIATION.test(t) || PERSON_NAME.test(t) || isAuthorList(t)) return false;
    if (/^(\d+(\.\d+)*\.?|[IVX]+\.)\s/.test(t)) return false;
    // Keyword lists ("streamlining, dissolved organic matter, …") are not titles.
    if (/^\p{Ll}/u.test(t) && (t.match(/[,;]/g) ?? []).length >= 3) return false;
    // Sentences are not titles.
    if (/[.。]$/.test(t) && block.units > 8) return false;
    return (t.match(/\p{L}/gu)?.length ?? 0) / t.length > 0.6;
}

/**
 * Approximate font size of a text block from its area and character count,
 * independent of line wrapping: area ≈ chars × 0.5·size × 1.15·size.
 */
function estimatedFontSize(block: Block): number {
    const [x0, y0, x1, y1] = block.bbox!;
    const chars = Math.max(1, block.text.length);
    return Math.sqrt(Math.max(0, (x1 - x0) * (y1 - y0)) / (0.575 * chars));
}

/**
 * Titles set over several lines are sometimes split into separate blocks. Join
 * vertically adjacent blocks of the same font size on either side of `best`.
 */
function mergeTitleLines(blocks: Block[], best: Block): Block[] {
    const size = estimatedFontSize(best);
    const sameLine = (b: Block) =>
        b !== best && b.unit === best.unit && b.bbox && (b.kind === 'heading' || b.kind === 'text')
        && b.units <= 30 && Math.abs(estimatedFontSize(b) - size) <= size * 0.12
        && !AUTHOR_MARKERS.test(b.text) && !PERSON_NAME.test(b.text) && !isAuthorList(b.text) && !isBoilerplate(b)
        && !AFFILIATION.test(b.text) && !JOURNALISH.test(b.text) && !/[.。]$/.test(b.text)
        && !ABSTRACT_LABEL.test(b.text) && !KEYWORD_LABEL.test(b.text) && !STRUCTURED_ABSTRACT_PART.test(b.text);
    const lines = [best];
    for (;;) {
        const top = lines[0].bbox!;
        const bottom = lines[lines.length - 1].bbox!;
        const above = blocks.find((b) => sameLine(b) && !lines.includes(b)
            && b.bbox![3] <= top[1] + 1 && top[1] - b.bbox![3] < size * 0.9
            && b.bbox![0] < top[2] && b.bbox![2] > top[0]);
        const below = blocks.find((b) => sameLine(b) && !lines.includes(b)
            && b.bbox![1] >= bottom[3] - 1 && b.bbox![1] - bottom[3] < size * 0.9
            && b.bbox![0] < bottom[2] && b.bbox![2] > bottom[0]);
        if (!above && !below) break;
        if (above) lines.unshift(above);
        if (below) lines.push(below);
        if (lines.length >= 4) break;
    }
    return lines;
}

/**
 * The title on the first content page: the largest-font title-like block in
 * the upper part of the page. Without geometry, the first title-like heading.
 */
function documentTitleBlocks(blocks: Block[], skipUnits: Set<number>): Block[] | null {
    const firstUnit = blocks.find((b) => !skipUnits.has(b.unit) && b.units > 0)?.unit;
    const candidates = blocks.filter((b) => b.unit === firstUnit && isTitleCandidate(b));
    const placed = candidates.filter((b) => b.bbox && b.pageHeight && b.bbox[1] < b.pageHeight * 0.6);
    if (placed.length) {
        let best = placed[0];
        for (const b of placed) if (estimatedFontSize(b) > estimatedFontSize(best)) best = b;
        return mergeTitleLines(blocks, best);
    }
    const heading = candidates.find((b) => b.kind === 'heading' && b.units >= 3);
    return heading ? [heading] : null;
}

/** Title lines from the first content page, else from a cover sheet (which usually repeats it). */
function pdfTitleBlocks(blocks: Block[], skipUnits: Set<number>): Block[] | null {
    const lines = documentTitleBlocks(blocks, skipUnits);
    if (lines || skipUnits.size === 0) return lines;
    return documentTitleBlocks(blocks.filter((b) => skipUnits.has(b.unit)), new Set());
}

function contentWords(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/\p{L}{3,}|[\u3400-\u9fff]/gu) ?? []);
}

/** The block on the first content pages that carries a known title, if any. */
function locateTitleBlock(blocks: Block[], skipUnits: Set<number>, title: string): Block | null {
    const want = contentWords(title);
    if (want.size === 0) return null;
    const units = [...new Set(blocks.filter((b) => !skipUnits.has(b.unit)).map((b) => b.unit))].slice(0, 2);
    for (const b of blocks) {
        if (!units.includes(b.unit) || (b.kind !== 'heading' && b.kind !== 'text') || b.units > 60) continue;
        const have = contentWords(b.text);
        let shared = 0;
        for (const w of have) if (want.has(w)) shared++;
        if (have.size && shared / have.size >= 0.6 && shared / want.size >= 0.4) return b;
    }
    return null;
}

/**
 * EPUB and snapshot titles come from the documents' `<title>` elements. EPUB
 * sections usually repeat the book title, so the most frequent label wins.
 * Web page titles usually carry the site name ("… - NYTimes.com"); a heading
 * that makes up most of the page title is the article title without it.
 */
function domTitle(document: DomDocument, contentKind: 'epub' | 'snapshot', blocks: Block[]): string | null {
    const counts = new Map<string, number>();
    for (const section of document.sections) {
        const label = section.label ? normalizeText(section.label) : '';
        if (!label || DOM_BAD_TITLE.test(label) || GENERIC_SECTION_LABEL.test(label)) continue;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    let label: string | null = null;
    for (const [l, n] of counts) if (!label || n > counts.get(label)!) label = l;
    if (!label || contentKind === 'epub') return label;
    const lower = label.toLowerCase();
    const heading = blocks.find((b) => b.kind === 'heading' && b.units >= 3 && b.units <= 40
        && b.text.length >= lower.length * 0.4 && lower.includes(b.text.toLowerCase()));
    return heading?.text ?? label;
}

/**
 * `<title>` values that are file names, identifiers or placeholders. Unlike the
 * PDF metadata filter, this keeps single-word titles ("Frankenstein", "1984").
 */
const DOM_BAD_TITLE =
    /^(untitled|microsoft (word|powerpoint))\b|\.(x?html?|epub|pdf|docx?|pptx?|tex)$|^doi:|^\d{1,2}$|^\d{9,}[\dx]?$|^[\w-]*_[\w-]*$|^[\w-]+\.(com|org|net|edu|gov)$/i;

/** Section and placeholder labels that name a part of a book rather than the book. */
const GENERIC_SECTION_LABEL = new RegExp(
    '^(' + [
        'cover( page)?', 'portada', 'title( page)?', 'half[- ]?title( page)?', 'copyright( page)?', 'imprint',
        'contents', 'table of contents', 'dedication', 'acknowledge?ments?', 'advertisement', 'credits',
        'introduction', 'preface', 'foreword', 'prologue', 'prólogo', 'epilogue', 'conclusion', 'notes',
        'appendix', 'glossary', 'index', 'bibliography', 'about the authors?', 'p[áa]gina legal', 'legal',
        'unknown', 'unbekannt', 'inconnu', 'desconocido', 'sconosciuto',
        'document outline', 'abstract', 'summary', 'resumen', 'résumé', 'zusammenfassung',
        '(book|part|chapter|section|volume) [\\divxlcdm]+',
        '((book|part|chapter|section|volume) )?(one|two|three|four|five|six|seven|eight|nine|ten)',
        '[ivxlcdm]+',
    ].join('|') + ')$',
    'i',
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function deriveEmbeddingText(source: EmbeddingTextSource, options: EmbeddingTextOptions = {}): EmbeddingText {
    const maxBodyChars = options.maxBodyChars ?? DEFAULTS.maxBodyChars;
    const maxKeywordChars = options.maxKeywordChars ?? DEFAULTS.maxKeywordChars;

    let blocks: Block[];
    let skipUnits = new Set<number>();
    if (source.contentKind === 'pdf') {
        // Books and reports spend more pages on title pages, dedications and prefaces.
        const maxPages = options.maxPages
            ?? (source.document.pageCount > LONG_DOCUMENT_PAGES ? DEFAULTS.maxPages * 2 : DEFAULTS.maxPages);
        ({ blocks, skipUnits } = pdfBlocks(source.document, maxPages));
    } else {
        ({ blocks, skipUnits } = domBlocks(source.document, source.contentKind));
    }

    let title: string | null = options.title ? normalizeText(options.title) || null : null;
    let titleSource: EmbeddingTitleSource | null = title ? 'provided' : null;
    let titleBlock: Block | null = null;
    if (source.contentKind === 'pdf') {
        if (!title) {
            title = plausiblePdfTitle(source.pdfTitle, blocks);
            if (title) titleSource = 'pdf_metadata';
        }
        if (!title) {
            const lines = pdfTitleBlocks(blocks, skipUnits);
            if (lines) {
                title = lines.map((b) => b.text).join(' ');
                titleSource = 'document';
                titleBlock = lines[lines.length - 1];
            }
        }
        if (title && !titleBlock) titleBlock = locateTitleBlock(blocks, skipUnits, title);
    } else if (!title) {
        title = domTitle(source.document, source.contentKind, blocks);
        if (title) titleSource = 'document';
    }

    const keywords = findKeywords(blocks, skipUnits, maxKeywordChars);
    let body = findAbstract(blocks, skipUnits, maxBodyChars);
    let bodySource: EmbeddingBodySource = body ? 'abstract' : 'none';
    if (!body) {
        body = findOpening(blocks, skipUnits, maxBodyChars, titleBlock);
        if (body) bodySource = 'opening';
    }
    if (!body && source.contentKind !== 'snapshot') {
        body = findOutline(blocks, skipUnits, Math.min(maxBodyChars, MAX_OUTLINE_CHARS));
        if (body) bodySource = 'outline';
    }

    const text = [title, keywords ? `Keywords: ${keywords}` : null, body]
        .filter((part): part is string => !!part)
        .join('\n\n');
    return { text, title, titleSource, keywords, body: body ?? '', bodySource };
}
