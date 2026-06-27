import { logger } from "../../../utils/logger";
import { NON_CONTENT_SELECTOR, normalizeText } from "./domWalk";

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
    const textNodes = collectTextNodes(block);
    if (textNodes.length === 0) return undefined;
    const first = textNodes[0];
    const last = textNodes[textNodes.length - 1];
    const blockRange = block.ownerDocument.createRange();
    blockRange.setStart(first, 0);
    blockRange.setEnd(last, (last.nodeValue ?? "").length);
    if (!normalizeText(blockRange.toString())) {
        blockRange.detach();
        return undefined;
    }
    return blockRange;
}

/** Find an element by id within `root`, escaping the id for attribute-selector use. */
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
    if (offset === -1) return undefined;

    const start = flattened.positions[offset];
    const end = flattened.positions[offset + normalizedSentence.length - 1];
    if (!start || !end) return undefined;

    const range = element.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
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
