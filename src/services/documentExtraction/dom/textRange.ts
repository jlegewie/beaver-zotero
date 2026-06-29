import { logger } from "../../../utils/logger";
import { NON_CONTENT_SELECTOR, normalizeText, visibleTextContent } from "./domWalk";

/**
 * Pure DOM text-search helpers shared by the DOM-document content kinds (EPUB and
 * web snapshots), across both the live reader citation path
 * (`react/utils/epubVisualizer`, `react/utils/snapshotVisualizer`) and the
 * headless annotation resolvers. These operate on any parsed `Document`/`Element`
 * — they do not touch the Zotero reader — so they live in `src/` and stay free of
 * React/Jotai/reader imports. The React resolvers re-export them unchanged.
 */

// NodeFilter.SHOW_TEXT. Use the spec-fixed literal rather than a global: a
// document parsed by DOMParser outside a window has no `defaultView`, so the
// global `NodeFilter` may be unavailable in the headless path.
const SHOW_TEXT = 0x4;
// Node.ELEMENT_NODE — same rationale as SHOW_TEXT (no live `Node` global).
const ELEMENT_NODE = 1;

/**
 * Block-level container element names, mirroring the reader's getContainingBlock
 * tag set (reader/src/dom/common/lib/nodes.ts). The reader additionally consults
 * computed `display`, but a DOMParser document has no layout, so the headless
 * path relies on the tag set — the robust signal for DOM-document content.
 */
const BLOCK_ELEMENT_NAMES = new Set([
    "div", "p", "li", "ol", "ul", "table", "thead", "tbody", "tr", "td", "th",
    "dl", "dt", "dd", "form", "fieldset", "section", "header", "footer",
    "aside", "nav", "article", "h1", "h2", "h3", "h4", "h5", "h6",
]);

/** Nearest ancestor-or-self block element of `node`, or undefined if none. */
export function getContainingBlockElement(node: Node): Element | undefined {
    let el: Element | null = node.nodeType === ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    while (el) {
        if (BLOCK_ELEMENT_NAMES.has(el.localName.toLowerCase())) return el;
        el = el.parentElement;
    }
    return undefined;
}

/**
 * Range over the containing block element of `range`'s start, bounded by the
 * block's first and last content text nodes. Note/point annotations anchor here
 * so the reader renders the comment icon in the margin beside the block (it
 * places the icon just past the right edge of a note's range bbox; a
 * block-spanning range reaches the content column's right edge). This matches
 * the native reader's note placement (selectNode(containingBlock) then
 * moveRangeEndsIntoTextNodes), keeping the CFI endpoints in text nodes so it
 * resolves cleanly. Returns undefined when there is no block ancestor or it has
 * no text content.
 */
export function createContainingBlockRange(range: Range): Range | undefined {
    const block = getContainingBlockElement(range.startContainer);
    if (!block) return undefined;
    return rangeOverElementText(block);
}

/**
 * Range spanning an element's content, bounded by its first and last content text
 * nodes (so the endpoints sit in text nodes, which the reader's selectors resolve
 * cleanly). Returns undefined when the element has no visible text.
 */
function rangeOverElementText(element: Element): Range | undefined {
    const textNodes = collectTextNodes(element);
    if (textNodes.length === 0) return undefined;
    const first = textNodes[0];
    const last = textNodes[textNodes.length - 1];
    const range = element.ownerDocument.createRange();
    range.setStart(first, 0);
    range.setEnd(last, (last.nodeValue ?? "").length);
    if (!normalizeText(range.toString())) {
        range.detach();
        return undefined;
    }
    return range;
}

/**
 * Find an element by id within `root`, escaping the id for attribute-selector use.
 *
 * Returns the first match, matching the reader's querySelector-based resolution.
 */
export function findAnchorElement(root: Element, anchorId: string): Element | undefined {
    // Attribute selector instead of #id so arbitrary ids only need string escaping.
    const escaped = anchorId.replace(/["\\]/g, "\\$&");
    try {
        return root.querySelector(`[id="${escaped}"]`) ?? undefined;
    } catch (error) {
        logger(`[DomTextRange] Invalid citation anchor id "${anchorId}": ${error}`, 1);
        return undefined;
    }
}

/**
 * Build the ordered search-text candidates for a cited passage. The raw
 * normalized text is tried first: sentence text can legitimately contain literal
 * angle-bracket markup (e.g. code samples rendered in the content), and stripping
 * it would leave nothing to match. The tag-stripped variant is the fallback for
 * preview text that arrives as an HTML fragment.
 */
export function citationSearchTextCandidates(text: string | undefined): string[] {
    if (!text) return [];
    const candidates: string[] = [];
    const raw = normalizeText(text);
    if (raw) candidates.push(raw);
    const stripped = normalizeText(text.replace(/<[^>]*>/g, " "));
    if (stripped && stripped !== raw) candidates.push(stripped);
    return candidates;
}

/** Normalize an href to its lowercase basename (no query/hash) for matching. */
export function normalizeHrefBasename(href: string | undefined): string | undefined {
    if (!href) return undefined;
    const withoutHash = href.split("#", 1)[0];
    const withoutQuery = withoutHash.split("?", 1)[0];
    const parts = withoutQuery.split("/").filter(Boolean);
    return parts[parts.length - 1]?.toLowerCase();
}

/** Create a range spanning the full content of `element`, or undefined if empty. */
export function createElementContentsRange(element: Element): Range | undefined {
    const doc = element.ownerDocument;
    const range = doc.createRange();
    try {
        range.selectNodeContents(element);
        if (normalizeText(range.toString())) return range;
    } catch (error) {
        logger(`[DomTextRange] Failed to create DOM item range: ${error}`, 1);
    }
    range.detach();
    return undefined;
}

/**
 * Locate `sentenceText` within `element` and return a DOM range covering it.
 * Matching is whitespace-normalized across the element's text nodes, so the
 * range survives inline markup splitting the sentence. Returns the first match.
 */
export function createSentenceRange(element: Element, sentenceText: string): Range | undefined {
    const normalizedSentence = normalizeText(sentenceText);
    if (!normalizedSentence) return undefined;

    const textNodes = collectTextNodes(element);
    const flattened = flattenTextNodes(textNodes);
    const offset = flattened.normalized.indexOf(normalizedSentence);
    if (offset === -1) {
        // A data-table row is extracted as "cell | cell | cell"; that separator
        // never appears verbatim in the DOM, so the flat search above cannot find
        // it. Fall back to locating the row structurally and ranging over it.
        return createTableRowRange(element, normalizedSentence);
    }

    const start = flattened.positions[offset];
    const end = flattened.positions[offset + normalizedSentence.length - 1];
    if (!start || !end) return undefined;

    const range = element.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
}

/** Locator for a cited passage: a DOM anchor id and/or the passage text. */
export interface AnchoredTextLocator {
    /** DOM id of the cited element, when known. */
    anchorId?: string;
    /** Cited passage text used to locate a precise range. */
    text?: string;
}

/**
 * Resolve a cited passage to a DOM range inside `root` using the three-tier
 * search shared by the live reader citation paths (EPUB + snapshot) and the
 * headless annotation resolvers, so a navigation spotlight and a saved
 * annotation cover the same locators:
 *
 *   1. anchor-scoped sentence search (when the anchor id resolves an element),
 *   2. body-wide sentence search,
 *   3. a range over the anchor element's full contents.
 */
export function resolveAnchoredTextRange(
    root: Element,
    locator: AnchoredTextLocator,
): Range | undefined {
    const anchorElement = locator.anchorId
        ? findAnchorElement(root, locator.anchorId)
        : undefined;
    const searchTexts = citationSearchTextCandidates(locator.text);

    if (anchorElement) {
        for (const searchText of searchTexts) {
            const range = createSentenceRange(anchorElement, searchText);
            if (range) return range;
        }
    }
    for (const searchText of searchTexts) {
        const range = createSentenceRange(root, searchText);
        if (range) return range;
    }
    if (anchorElement) {
        return createElementContentsRange(anchorElement);
    }
    return undefined;
}

// Cell separator that extraction uses when linearizing a data-table row (mirrors
// linearizeTableRows in domWalk.ts). Single-spaced, so it survives normalizeText.
const TABLE_ROW_CELL_SEPARATOR = " | ";

/** Linearize one table row's direct cells the way extraction does, or undefined if all empty. */
function linearizeRowCells(tr: Element): string | undefined {
    const cells: string[] = [];
    for (const cell of Array.from(tr.children) as Element[]) {
        const name = cell.localName.toLowerCase();
        if (name !== "td" && name !== "th") continue;
        cells.push(visibleTextContent(cell));
    }
    if (!cells.some((cell) => cell.length > 0)) return undefined;
    return cells.join(TABLE_ROW_CELL_SEPARATOR);
}

/**
 * True when `prefix` equals `text`, or is a prefix of `text` that ends on a cell
 * boundary (the next characters are the cell separator).
 */
function isCellAlignedPrefix(text: string, prefix: string): boolean {
    if (!text.startsWith(prefix)) return false;
    if (text.length === prefix.length) return true;
    return text.slice(prefix.length).startsWith(TABLE_ROW_CELL_SEPARATOR);
}

/**
 * Locate a cited data-table row inside `root` and return a range over it.
 */
export function createTableRowRange(root: Element, normalizedRowText: string): Range | undefined {
    if (!normalizedRowText.includes(TABLE_ROW_CELL_SEPARATOR)) return undefined;

    const trElements = root.localName?.toLowerCase() === "tr"
        ? [root, ...Array.from(root.querySelectorAll("tr"))]
        : Array.from(root.querySelectorAll("tr"));

    // Normalize each reconstruction: extraction joins cells without a final
    // whitespace collapse, so a row with an empty cell is stored with a double
    // space ("A |  | C") while the cited text arrives already normalized to a
    // single space. Compare both on the same normalized scale.
    const candidates: { tr: Element; linearized: string }[] = [];
    for (const tr of trElements as Element[]) {
        const linearized = linearizeRowCells(tr);
        if (linearized) candidates.push({ tr, linearized: normalizeText(linearized) });
    }

    // Prefer an exact match: a shorter row whose text is a prefix of a longer one
    // must not be stolen by the longer row via the prefix fallback below.
    const exact = candidates.find((c) => c.linearized === normalizedRowText);
    if (exact) return rangeOverElementText(exact.tr);

    // Truncated citation: either side a cell-aligned prefix of the other still
    // resolves. The cell-boundary check (see isCellAlignedPrefix) keeps this from
    // matching prose/code that merely contains " | ".
    let best: { tr: Element; linearized: string } | undefined;
    for (const c of candidates) {
        if (!c.linearized.includes(TABLE_ROW_CELL_SEPARATOR)) continue;
        const matches =
            isCellAlignedPrefix(c.linearized, normalizedRowText)
            || isCellAlignedPrefix(normalizedRowText, c.linearized);
        if (matches && (!best || c.linearized.length > best.linearized.length)) {
            best = c;
        }
    }
    return best ? rangeOverElementText(best.tr) : undefined;
}

/** Collect the content text nodes under `root`, skipping style/script subtrees. */
export function collectTextNodes(root: Element): Text[] {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, SHOW_TEXT);
    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
        // Extraction skips non-content subtrees (style/script), so the live
        // text walk must skip them too or extracted sentence text will not
        // line up with the flattened live text.
        if (!(current as Text).parentElement?.closest(NON_CONTENT_SELECTOR)) {
            nodes.push(current as Text);
        }
        current = walker.nextNode();
    }
    return nodes;
}

interface FlattenedText {
    normalized: string;
    positions: Array<{ node: Text; offset: number }>;
}

/**
 * Flatten text nodes into a whitespace-collapsed string plus a per-character
 * back-map to the originating (node, offset), so a substring match maps back to
 * a DOM range.
 */
export function flattenTextNodes(nodes: Text[]): FlattenedText {
    let normalized = "";
    const positions: Array<{ node: Text; offset: number }> = [];
    let pendingSpace: { node: Text; offset: number } | undefined;

    for (const node of nodes) {
        const value = node.nodeValue ?? "";
        for (let offset = 0; offset < value.length; offset++) {
            const char = value[offset];
            if (/\s/.test(char)) {
                pendingSpace = { node, offset };
                continue;
            }

            if (pendingSpace && normalized.length > 0) {
                normalized += " ";
                positions.push(pendingSpace);
            }
            pendingSpace = undefined;
            normalized += char;
            positions.push({ node, offset });
        }
    }

    return { normalized: normalized.trim(), positions };
}
