/**
 * Short forms of CSL locator types (`chapter` → `chap.`), as CSL's en-US
 * locale writes them. LaTeX postnotes carry them as text: biblatex adds "p."
 * only to a bare page number, and natbib adds nothing.
 */

const SHORT_TERMS: Record<string, string> = {
    act: 'act',
    appendix: 'app.',
    'article-locator': 'art.',
    book: 'bk.',
    canon: 'can.',
    chapter: 'chap.',
    column: 'col.',
    elocation: 'loc.',
    equation: 'eq.',
    figure: 'fig.',
    folio: 'fol.',
    issue: 'no.',
    line: 'l.',
    note: 'n.',
    opus: 'op.',
    page: 'p.',
    paragraph: 'para.',
    part: 'pt.',
    rule: 'r.',
    scene: 'sc.',
    section: 'sec.',
    'sub-verbo': 's.v.',
    table: 'tbl.',
    timestamp: '',
    'title-locator': 'tit.',
    verse: 'v.',
    volume: 'vol.',
};

/** The short term of a locator type (unknown types as written). */
export function locatorTerm(label: string): string {
    return label in SHORT_TERMS ? SHORT_TERMS[label] : label;
}

/** Whether a locator type is a page (absent means page). */
export function isPageLabel(label: string | undefined): boolean {
    return !label || label === 'page';
}
