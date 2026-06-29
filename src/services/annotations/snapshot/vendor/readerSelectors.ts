/**
 * Vendored selector helpers from the Zotero reader, kept byte-faithful so headless
 * snapshot annotation positions match the live `SnapshotView`. Sources:
 *   - reader/src/dom/common/lib/unique-selector.ts  (getUniqueSelectorContaining)
 *   - reader/src/dom/common/lib/selector.ts          (textPositionFromRange/ToRange + types)
 *   - reader/src/dom/common/lib/nodes.ts             (closestElement, iterateWalker)
 *   - reader/src/dom/common/lib/range.ts             (moveRangeEndsIntoTextNodes)
 *   - reader/src/common/lib/utilities.js             (isFirefox, isWin)
 *
 * Only the functions the snapshot selector/sortIndex path needs are vendored.
 * Layout-dependent helpers from those files (isBlock/getContainingBlock/isRTL/
 * isVertical via getComputedStyle, getClientRects) are intentionally omitted —
 * they are unavailable in the headless DOMParser document (no `defaultView`).
 *
 * Spec-fixed node-type / NodeFilter literals replace the `Node`/`NodeFilter`
 * globals, which a DOMParser document outside a window may not expose.
 */

const SHOW_TEXT = 0x4;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// --- Web Annotation Data Model selector subset (reader/.../selector.ts) -------

export type CssSelector = {
    type: "CssSelector";
    value: string;
    refinedBy?: SnapshotSelector;
};

export type TextPositionSelector = {
    type: "TextPositionSelector";
    start: number;
    end: number;
    refinedBy?: SnapshotSelector;
};

/** The selector shapes a snapshot annotation `position` uses. */
export type SnapshotSelector = CssSelector | TextPositionSelector;

// --- Platform predicates (reader/src/common/lib/utilities.js) -----------------

export const isFirefox = typeof (globalThis as { InstallTrigger?: unknown }).InstallTrigger !== "undefined";

export function isWin(): boolean {
    return typeof navigator !== "undefined" && /Win/.test(navigator.platform);
}

// --- nodes.ts -----------------------------------------------------------------

function isElement(node: unknown): node is Element {
    return !!node
        && typeof node === "object"
        && "nodeType" in node
        && (node as Node).nodeType === ELEMENT_NODE;
}

export function closestElement(node: Node): Element | null {
    let currentNode: Node | null = node;
    while (currentNode && !isElement(currentNode)) {
        currentNode = currentNode.parentNode;
    }
    return currentNode;
}

export function iterateWalker(
    walker: TreeWalker | NodeIterator,
    direction: "forward" | "backward" = "forward",
): Iterable<Node> {
    if (direction === "forward") {
        return {
            [Symbol.iterator]: function* () {
                let node: Node | null;
                while ((node = walker.nextNode())) {
                    yield node;
                }
            },
        };
    }
    return {
        [Symbol.iterator]: function* () {
            let node: Node | null;
            while ((node = walker.previousNode())) {
                yield node;
            }
        },
    };
}

// --- range.ts -----------------------------------------------------------------

/**
 * Return a clone of the range with text-node-child endpoints moved inside the
 * text nodes (trimming leading/trailing newlines). Mirrors the reader exactly.
 */
export function moveRangeEndsIntoTextNodes(range: Range): Range {
    const doc = range.commonAncestorContainer.ownerDocument!;
    range = range.cloneRange();

    // If the range selects a single <img>, leave it be
    if (range.startContainer === range.endContainer
            && range.startOffset === range.endOffset - 1
            && range.startContainer.nodeType === ELEMENT_NODE
            && (range.startContainer as Element).childNodes[range.startOffset].nodeName === "IMG") {
        return range;
    }

    if (range.startContainer.nodeType !== TEXT_NODE) {
        let startNode: Node | null = range.startContainer.childNodes.length
            ? range.startContainer.childNodes[Math.max(range.startOffset, 0)]
            : null;
        if (!startNode || startNode.nodeType !== TEXT_NODE) {
            const walker = doc.createTreeWalker(doc, SHOW_TEXT);
            if (range.startContainer.childNodes.length && range.startOffset === range.startContainer.childNodes.length) {
                startNode = range.startContainer.childNodes[range.startContainer.childNodes.length - 1];
            }
            walker.currentNode = startNode || range.startContainer;
            startNode = walker.nextNode();
        }
        if (startNode) {
            let offset = 0;
            if (startNode.nodeValue) {
                while (offset < startNode.nodeValue.length && startNode.nodeValue.charAt(offset) == "\n") {
                    offset++;
                }
            }
            range.setStart(startNode, offset);
        }
    }
    if (range.endContainer.nodeType !== TEXT_NODE) {
        let endNode: Node | null = range.endContainer.childNodes.length
            ? range.endContainer.childNodes[Math.min(range.endOffset - 1, range.endContainer.childNodes.length - 1)]
            : null;
        if (!endNode || endNode.nodeType !== TEXT_NODE) {
            const walker = doc.createTreeWalker(endNode || range.endContainer, SHOW_TEXT);
            while (walker.nextNode()) { /* advance to last text node */ }
            endNode = walker.currentNode;
        }
        if (endNode) {
            let offset = 0;
            if (endNode.nodeValue) {
                offset = endNode.nodeValue.length;
                while (offset > 0 && endNode.nodeValue.charAt(offset - 1) == "\n") {
                    offset--;
                }
            }
            range.setEnd(endNode, offset);
        }
    }

    // Firefox on Windows adds an extra space at the end of a word selection.
    if (isFirefox && isWin()
            && range.endContainer.nodeType === TEXT_NODE
            && range.endOffset > 0
            && /\s/.test(range.endContainer.nodeValue!.charAt(range.endOffset - 1))) {
        range.setEnd(range.endContainer, range.endOffset - 1);
    }

    return range;
}

// --- selector.ts --------------------------------------------------------------

export function textPositionFromRange(range: Range, root: Node): TextPositionSelector | null {
    range = moveRangeEndsIntoTextNodes(range);
    const iter = root.ownerDocument!.createNodeIterator(root, SHOW_TEXT);
    const selector: Partial<TextPositionSelector> = {
        type: "TextPositionSelector",
    };
    let pos = 0;
    for (const node of iterateWalker(iter)) {
        if (node === range.startContainer) {
            selector.start = pos + range.startOffset;
        }
        if (node === range.endContainer) {
            selector.end = pos + range.endOffset;
        }
        if (node.nodeValue) {
            pos += node.nodeValue.length;
        }
    }
    if (selector.start === undefined || selector.end === undefined) {
        return null;
    }
    return selector as TextPositionSelector;
}

export function textPositionToRange(selector: TextPositionSelector, root: Element): Range {
    const iter = root.ownerDocument.createNodeIterator(root, SHOW_TEXT);
    const range = root.ownerDocument.createRange();
    let pos = 0;
    for (const node of iterateWalker(iter)) {
        if (!node.nodeValue) {
            continue;
        }
        const startOffset = selector.start - pos;
        if (startOffset >= 0 && startOffset <= node.nodeValue.length) {
            range.setStart(node, startOffset);
        }
        const endOffset = selector.end - pos;
        if (endOffset >= 0 && endOffset <= node.nodeValue.length) {
            range.setEnd(node, endOffset);
        }
        pos += node.nodeValue.length;
    }
    return range;
}

// --- unique-selector.ts -------------------------------------------------------

/**
 * CSS.escape when available (window scope), else a spec-compliant fallback.
 */
function cssEscape(value: string): string {
    const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
    if (css?.escape) {
        return css.escape(value);
    }
    const string = String(value);
    const length = string.length;
    const firstCodeUnit = string.charCodeAt(0);
    // A lone "-" must be escaped; a "-" followed by more characters need not be.
    if (length === 1 && firstCodeUnit === 0x002d) {
        return `\\${string}`;
    }
    let result = "";
    for (let index = 0; index < length; index++) {
        const codeUnit = string.charCodeAt(index);
        // NULL → U+FFFD REPLACEMENT CHARACTER.
        if (codeUnit === 0x0000) {
            result += "�";
            continue;
        }
        if (
            // Control characters and U+007F: escape as a code point.
            (codeUnit >= 0x0001 && codeUnit <= 0x001f) || codeUnit === 0x007f
            // Leading digit, or a digit right after a leading "-".
            || (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039)
            || (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
        ) {
            result += `\\${codeUnit.toString(16)} `;
            continue;
        }
        // Identifier-safe characters (incl. non-ASCII >= U+0080) pass through.
        if (
            codeUnit >= 0x0080
            || codeUnit === 0x002d
            || codeUnit === 0x005f
            || (codeUnit >= 0x0030 && codeUnit <= 0x0039)
            || (codeUnit >= 0x0041 && codeUnit <= 0x005a)
            || (codeUnit >= 0x0061 && codeUnit <= 0x007a)
        ) {
            result += string.charAt(index);
            continue;
        }
        // Everything else: escape the character itself.
        result += `\\${string.charAt(index)}`;
    }
    return result;
}

/** Generate a CSS selector uniquely pointing to `element`, relative to its body. */
export function getUniqueSelectorContaining(element: Element): string | null {
    const root = element.closest("body");
    if (!root) {
        throw new Error("Element has no body ancestor");
    }

    const testSelector = (selector: string): boolean => {
        return root.querySelectorAll(selector).length == 1 && root.querySelector(selector) == element;
    };

    let currentElement: Element | null = element;
    let selector = "";
    while (currentElement && currentElement !== root) {
        const joiner = selector ? " > " : "";
        if (currentElement.id) {
            return `#${cssEscape(currentElement.id)}` + joiner + selector;
        }

        const tagName = currentElement.tagName.toLowerCase();

        const prevSibling = currentElement.previousElementSibling;
        if (prevSibling && prevSibling.id) {
            const prevSiblingIDSelector = `#${cssEscape(prevSibling.id)} + ${tagName}${joiner}${selector}`;
            if (testSelector(prevSiblingIDSelector)) {
                return prevSiblingIDSelector;
            }
        }

        let childPseudoclass: string;
        if (currentElement.matches(":only-of-type") || currentElement.matches(":only-child")) {
            childPseudoclass = "";
        } else if (currentElement.matches(":first-child")) {
            childPseudoclass = ":first-child";
        } else if (currentElement.matches(":first-of-type")) {
            childPseudoclass = ":first-of-type";
        } else if (currentElement.matches(":last-child")) {
            childPseudoclass = ":last-child";
        } else if (currentElement.matches(":last-of-type")) {
            childPseudoclass = ":last-of-type";
        } else if (currentElement.parentElement) {
            childPseudoclass = `:nth-child(${[...currentElement.parentElement.children].indexOf(currentElement) + 1})`;
        } else {
            break;
        }

        selector = tagName + childPseudoclass + joiner + selector;

        if (testSelector(selector)) {
            return selector;
        }

        currentElement = currentElement.parentElement;
    }
    return null;
}
