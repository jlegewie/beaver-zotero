import type { DomItemKind } from "./schema";

// EPUB-originated namespace support is harmless for plain HTML documents.
const EPUB_TYPE_NS = "http://www.idpf.org/2007/ops";

export interface DomElementMapping {
    kind: DomItemKind;
    level?: number;
}

export interface DomItemCandidate extends DomElementMapping {
    element: Element;
    text: string;
    anchorId?: string;
}

/** Normalize DOM text into a compact single-line string. */
export function normalizeText(text: string | null | undefined): string {
    return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Return the nearest stable element id at or above the current element. */
export function findNearestAnchorId(element: Element): string | undefined {
    let current: Element | null = element;
    while (current) {
        const id = current.getAttribute("id");
        if (id) return id;
        current = current.parentElement;
    }
    return undefined;
}

/** Detect footnote semantics without namespace-prefixed CSS selectors. */
export function isFootnoteElement(element: Element): boolean {
    const epubType = element.getAttributeNS(EPUB_TYPE_NS, "type");
    const plainType = element.getAttribute("type");
    const className = element.getAttribute("class");
    return hasToken(epubType, "footnote")
        || hasToken(plainType, "footnote")
        || hasToken(className, "footnote");
}

// Element names that break the inline text flow during the walk: each marks a
// boundary where accumulated prose is flushed and the element is visited on its
// own (a block container, or an image/figure that becomes its own item).
// Everything not listed here is treated as inline and folded into the
// surrounding text. The list is deliberately broad so unanticipated containers
// (e.g. `<dd>`, `<pre>`) keep their text instead of dropping it.
const BLOCK_LEVEL_NAMES = new Set([
    "div", "section", "article", "p", "blockquote", "pre", "address",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "caption", "figure", "figcaption",
    "nav", "header", "footer", "aside", "main", "details", "summary",
    "tr", "td", "th", "tbody", "thead", "tfoot",
    "img", "svg",
]);

function isBlockBoundary(element: Element): boolean {
    return BLOCK_LEVEL_NAMES.has(element.localName.toLowerCase());
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// A cell holding at least this many characters of prose marks a layout table
// (body text positioned in a table) rather than tabular data.
const LAYOUT_TABLE_PROSE_CHARS = 200;

/**
 * Distinguish a layout table (body text positioned in a table — common in
 * PDF/Word→EPUB conversions) from a genuine data table.
 *
 * Data tables are emitted as one opaque `table` item; layout tables are walked
 * transparently so their headings, paragraphs, and prose cells are recovered.
 */
function isLayoutTable(table: Element): boolean {
    // Header cells signal tabular data — keep those opaque.
    if (table.querySelector("th")) return false;
    // Block-flow content or nested tables inside cells are not tabular data.
    if (table.querySelector("table, p, div, h1, h2, h3, h4, h5, h6, blockquote, ul, ol")) {
        return true;
    }
    // No nested tables remain past this point, so cell counting is flat.
    const cells = Array.from(table.querySelectorAll("td"));
    // A single-cell table is a positioning wrapper, not a data grid.
    if (cells.length === 1) return true;
    // A cell carrying a long run of prose is body text laid out in a table.
    for (const cell of cells) {
        if (cell && normalizeText(cell.textContent).length >= LAYOUT_TABLE_PROSE_CHARS) {
            return true;
        }
    }
    return false;
}

/**
 * Classify a DOM element into a special item kind, or return `undefined` for a
 * generic element whose text is captured by the walk.
 *
 * This is the allowlist as an *override*: it names only the elements that carry
 * a distinct kind (heading, list item, caption, footnote, data table, picture).
 * Everything else — `div`, `td`, `dd`, `pre`, prose laid out in unrecognized
 * containers — falls through to `undefined` and is captured as generic text, so
 * the walk never drops body text just because a tag is unanticipated.
 */
export function mapElement(element: Element): DomElementMapping | undefined {
    if (isFootnoteElement(element)) {
        return { kind: "footnote" };
    }

    const name = element.localName.toLowerCase();
    if (name === "p" || name === "blockquote") return { kind: "text" };
    if (/^h[1-6]$/.test(name)) {
        return { kind: "section_header", level: Number(name.slice(1)) };
    }
    if (name === "li") return { kind: "list_item" };
    if (name === "figcaption") return { kind: "caption" };
    // Layout tables map to nothing so the walk descends into their cells; only
    // genuine data tables become an opaque `table` item.
    if (name === "table") return isLayoutTable(element) ? undefined : { kind: "table" };
    if (name === "img" || name === "svg") return { kind: "picture" };
    return undefined;
}

/**
 * Walk a DOM section body and emit ordered, non-duplicated item candidates.
 *
 * Modeled on the reader's Read Aloud DOM walk (the Mozilla Narrator algorithm):
 * text capture is the default and is tag-agnostic, so body text is never dropped
 * just because it sits in an unrecognized container. A {@link mapElement}
 * classification is an *override* — a special element (heading, list item,
 * caption, footnote, data table, picture) owns its whole subtree as one item and
 * is not descended into. Generic elements contribute their own inline text (in
 * document order) and the walk descends into their block-level children.
 */
export function collectDomItems(body: Element): DomItemCandidate[] {
    const candidates: DomItemCandidate[] = [];

    // Visit one element: a classified special element becomes its own item;
    // a generic element is opened up so its inline text and block children are
    // processed in order.
    const visit = (element: Element): void => {
        const mapping = mapElement(element);
        if (mapping) {
            const candidate = buildCandidate(element, mapping);
            if (candidate) candidates.push(candidate);
            return;
        }
        walkChildren(element);
    };

    // Process an element's children in document order, accumulating inline text
    // (text nodes + inline elements) and flushing it as a text item at each
    // block boundary before descending into that block child.
    const walkChildren = (parent: Element): void => {
        let buffer = "";
        const flush = (): void => {
            const text = normalizeText(buffer);
            buffer = "";
            if (text) {
                candidates.push({
                    element: parent,
                    kind: "text",
                    text,
                    anchorId: findNearestAnchorId(parent),
                });
            }
        };

        for (const node of Array.from(parent.childNodes)) {
            if (!node) continue;
            if (node.nodeType === TEXT_NODE) {
                buffer += ` ${node.nodeValue ?? ""} `;
            } else if (node.nodeType === ELEMENT_NODE) {
                const child = node as Element;
                if (isBlockBoundary(child)) {
                    flush();
                    visit(child);
                } else {
                    // Inline element: fold its text into the surrounding prose.
                    buffer += ` ${child.textContent ?? ""} `;
                }
            }
        }
        flush();
    };

    walkChildren(body);
    return candidates;
}

function buildCandidate(
    element: Element,
    mapping: DomElementMapping,
): DomItemCandidate | undefined {
    const text = textForMappedElement(element, mapping.kind);
    if (!text) return undefined;
    return {
        element,
        kind: mapping.kind,
        level: mapping.level,
        text,
        anchorId: findNearestAnchorId(element),
    };
}

function textForMappedElement(element: Element, kind: DomItemKind): string {
    if (kind === "picture") {
        return normalizeText(
            element.getAttribute("alt")
            || element.getAttribute("title"),
        );
    }
    return normalizeText(element.textContent);
}

function hasToken(value: string | null, token: string): boolean {
    if (!value) return false;
    return value.split(/\s+/).some((part) => part.toLowerCase() === token);
}
