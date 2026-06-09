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

// Block-level container names. A leaf-text container counts as a paragraph only
// when it has none of these as children — i.e. it is a leaf text block, not a
// wrapper around other blocks.
const BLOCK_LEVEL_NAMES = new Set([
    "div", "section", "article", "p", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "table", "figure", "figcaption",
    "nav", "header", "footer", "aside", "main",
    "tr", "td", "th", "tbody", "thead", "tfoot",
]);

// Containers that behave like a paragraph when they hold text directly (only
// inline children). `div`/`section`/`article` cover PDF/Word→EPUB conversions
// that use `<div>` for body text; `td`/`th` cover prose laid out in the cells of
// a layout table (only reached once a layout table is walked transparently).
const LEAF_TEXT_CONTAINER_NAMES = new Set([
    "div", "section", "article", "td", "th",
]);

// A cell holding at least this many characters of prose marks a layout table
// (body text positioned in a table) rather than tabular data.
const LAYOUT_TABLE_PROSE_CHARS = 200;

function hasBlockLevelChild(element: Element): boolean {
    for (const child of Array.from(element.children)) {
        if (BLOCK_LEVEL_NAMES.has(child.localName.toLowerCase())) return true;
    }
    return false;
}

/**
 * A leaf-text container holds text directly (only inline children) and is
 * treated as a paragraph. Without this, `<div>`-based bodies and prose laid out
 * in table cells extract to nothing.
 */
function isLeafTextBlock(element: Element): boolean {
    if (!LEAF_TEXT_CONTAINER_NAMES.has(element.localName.toLowerCase())) return false;
    if (hasBlockLevelChild(element)) return false;
    return normalizeText(element.textContent).length > 0;
}

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

/** Map a DOM element to the geometry-free item kind Beaver stores. */
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
    if (isLeafTextBlock(element)) return { kind: "text" };
    return undefined;
}

/** Walk a DOM section body and emit owned, non-duplicated item candidates. */
export function collectDomItems(body: Element): DomItemCandidate[] {
    const candidates: DomItemCandidate[] = [];

    const visit = (element: Element): void => {
        const mapping = mapElement(element);
        if (mapping) {
            const candidate = buildCandidate(element, mapping);
            if (candidate) {
                candidates.push(candidate);
            }
            if (ownsSubtree(element, mapping.kind)) return;
        }

        for (const child of Array.from(element.children)) {
            visit(child);
        }
    };

    for (const child of Array.from(body.children)) {
        visit(child);
    }

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

function ownsSubtree(element: Element, kind: DomItemKind): boolean {
    if (kind === "text") {
        const name = element.localName.toLowerCase();
        return name === "blockquote"
            || name === "p"
            || LEAF_TEXT_CONTAINER_NAMES.has(name);
    }
    return kind !== "picture";
}

function hasToken(value: string | null, token: string): boolean {
    if (!value) return false;
    return value.split(/\s+/).some((part) => part.toLowerCase() === token);
}
