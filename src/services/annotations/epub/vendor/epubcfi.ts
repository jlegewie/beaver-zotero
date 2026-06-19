/* eslint-disable */
/**
 * Vendored EpubCFI from epub.js `src/epubcfi.js` — **generation subset only**.
 *
 * Source: https://github.com/zotero/epub.js (fork used by the Zotero reader),
 * pinned commit a6139d586b66d404f3da2b846598960c0394afc5 — the reader's
 * `epubjs/epub.js` submodule revision. The Zotero reader builds EPUB annotation
 * positions with this exact class (`reader/src/dom/epub/epub-view.ts`), so
 * generating CFIs here against the same parsed DOM yields strings the reader
 * resolves. Keep in sync with that pinned commit; re-run the live parity test
 * if the reader bumps its epub.js submodule. epub.js is BSD-2-Clause licensed.
 *
 * Differences from upstream, all behavior-preserving for generation:
 * - Consumption/resolution methods (`parse`, `toRange`, `findNode`,
 *   `walkToNode`, `fixMiss`, `stepsToXpath`, `stepsToQuerySelector`, `compare`)
 *   are removed — this class only turns a Range/Node into a CFI string.
 * - Every `Node.*` constant is replaced with the local numeric constants
 *   below: a document parsed by DOMParser outside a window has no live `Node`
 *   global, and node-type numbers are spec-fixed.
 */

import { extend, type, findChildren, isNumber } from "./core";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

class EpubCFI {
    str = "";
    base: any = {};
    spinePos = 0; // For compatibility
    range = false; // true || false;
    path: any = {};
    start: any = null;
    end: any = null;

    constructor(cfiFrom?: any, base?: any, ignoreClass?: any) {
        var checked: any;

        // Allow instantiation without the "new" keyword
        if (!(this instanceof EpubCFI)) {
            return new EpubCFI(cfiFrom, base, ignoreClass);
        }

        if (typeof base === "string") {
            this.base = this.parseComponent(base);
        } else if (typeof base === "object" && base.steps) {
            this.base = base;
        }

        checked = this.checkType(cfiFrom);

        if (checked === "range") {
            return extend(this, this.fromRange(cfiFrom, this.base, ignoreClass));
        } else if (checked === "node") {
            return extend(this, this.fromNode(cfiFrom, this.base, ignoreClass));
        } else if (checked === "EpubCFI" && cfiFrom.path) {
            return cfiFrom;
        } else if (!cfiFrom) {
            return this;
        } else {
            // The generation-only vendor does not parse CFI strings.
            throw new TypeError("not a valid argument for EpubCFI (generation only)");
        }
    }

    /**
     * Check the type of constructor input
     * @private
     */
    checkType(cfi: any) {
        if (this.isCfiString(cfi)) {
            return "string";
            // Is a range object
        } else if (cfi && typeof cfi === "object" && (type(cfi) === "Range" || typeof (cfi.startContainer) != "undefined")) {
            return "range";
        } else if (cfi && typeof cfi === "object" && typeof (cfi.nodeType) != "undefined") { // || typeof cfi === "function"
            return "node";
        } else if (cfi && typeof cfi === "object" && cfi instanceof EpubCFI) {
            return "EpubCFI";
        } else {
            return false;
        }
    }

    parseComponent(componentStr: string) {
        var component: any = {
            steps: [],
            terminal: {
                offset: null,
                assertion: null,
            },
        };
        var parts = componentStr.split(":");
        var steps = parts[0].split("/");
        var terminal;

        if (parts.length > 1) {
            terminal = parts[1];
            component.terminal = this.parseTerminal(terminal);
        }

        if (steps[0] === "") {
            steps.shift(); // Ignore the first slash
        }

        component.steps = steps.map(function (this: EpubCFI, step: string) {
            return this.parseStep(step);
        }.bind(this));

        return component;
    }

    parseStep(stepStr: string) {
        var type, num, index, has_brackets, id;

        has_brackets = stepStr.match(/\[(.*)\]/);
        if (has_brackets && has_brackets[1]) {
            id = has_brackets[1];
        }

        //-- Check if step is a text node or element
        num = parseInt(stepStr);

        if (isNaN(num)) {
            return;
        }

        if (num % 2 === 0) { // Even = is an element
            type = "element";
            index = num / 2 - 1;
        } else {
            type = "text";
            index = (num - 1) / 2;
        }

        return {
            "type": type,
            "index": index,
            "id": id || null,
        };
    }

    parseTerminal(termialStr: string) {
        var characterOffset: number | null, textLocationAssertion;
        var assertion = termialStr.match(/\[(.*)\]/);

        if (assertion && assertion[1]) {
            characterOffset = parseInt(termialStr.split("[")[0]);
            textLocationAssertion = assertion[1];
        } else {
            characterOffset = parseInt(termialStr);
        }

        if (!isNumber(characterOffset)) {
            characterOffset = null;
        }

        return {
            "offset": characterOffset,
            "assertion": textLocationAssertion,
        };
    }

    joinSteps(steps: any[], excludeAssertions?: boolean) {
        if (!steps) {
            return "";
        }

        return steps.map(function (part) {
            var segment = "";

            if (part.type === "element") {
                segment += (part.index + 1) * 2;
            }

            if (part.type === "text") {
                segment += 1 + (2 * part.index); // TODO: double check that this is odd
            }

            if (!excludeAssertions && part.id) {
                segment += "[" + part.id + "]";
            }

            return segment;
        }).join("/");
    }

    segmentString(segment: any, excludeAssertions?: boolean) {
        var segmentString = "/";

        segmentString += this.joinSteps(segment.steps, excludeAssertions);

        if (segment.terminal && segment.terminal.offset != null) {
            segmentString += ":" + segment.terminal.offset;
        }

        if (!excludeAssertions && segment.terminal && segment.terminal.assertion != null) {
            segmentString += "[" + segment.terminal.assertion + "]";
        }

        return segmentString;
    }

    /**
     * Convert CFI to a epubcfi(...) string
     * @param {boolean} [excludeAssertions] Exclude bracketed assertions from the generated string
     * @returns {string} epubcfi
     */
    toString(excludeAssertions?: boolean) {
        var cfiString = "epubcfi(";

        cfiString += this.segmentString(this.base, excludeAssertions);

        cfiString += "!";
        cfiString += this.segmentString(this.path, excludeAssertions);

        // Add Range, if present
        if (this.range && this.start) {
            cfiString += ",";
            cfiString += this.segmentString(this.start, excludeAssertions);
        }

        if (this.range && this.end) {
            cfiString += ",";
            cfiString += this.segmentString(this.end, excludeAssertions);
        }

        cfiString += ")";

        return cfiString;
    }

    step(node: any) {
        var nodeType = (node.nodeType === TEXT_NODE) ? "text" : "element";

        return {
            "id": node.id,
            "tagName": node.tagName,
            "type": nodeType,
            "index": this.position(node),
        };
    }

    filteredStep(node: any, ignoreClass: any) {
        var filteredNode = this.filter(node, ignoreClass);
        var nodeType;

        // Node filtered, so ignore
        if (!filteredNode) {
            return;
        }

        // Otherwise add the filter node in
        nodeType = (filteredNode.nodeType === TEXT_NODE) ? "text" : "element";

        return {
            "id": filteredNode.id,
            "tagName": filteredNode.tagName,
            "type": nodeType,
            "index": this.filteredPosition(filteredNode, ignoreClass),
        };
    }

    pathTo(node: any, offset: number | null, ignoreClass: any) {
        var segment: any = {
            steps: [],
            terminal: {
                offset: null,
                assertion: null,
            },
        };
        var currentNode = node;
        var step;

        while (currentNode && currentNode.parentNode &&
            currentNode.parentNode.nodeType != DOCUMENT_NODE &&
            currentNode.parentNode.nodeType != DOCUMENT_FRAGMENT_NODE &&
            !(currentNode.parentNode.nodeType == ELEMENT_NODE
                && currentNode.parentNode.classList.contains("cfi-stop"))) {
            if (ignoreClass) {
                step = this.filteredStep(currentNode, ignoreClass);
            } else {
                step = this.step(currentNode);
            }

            if (step) {
                segment.steps.unshift(step);
            }

            currentNode = currentNode.parentNode;
        }

        if (offset != null && offset >= 0) {
            segment.terminal.offset = offset;

            // Make sure we are getting to a textNode if there is an offset
            if (node.nodeType === TEXT_NODE && (!segment.steps.length || segment.steps[segment.steps.length - 1].type != "text")) {
                segment.steps.push({
                    "type": "text",
                    "index": 0,
                });
            }
        }

        return segment;
    }

    equalStep(stepA: any, stepB: any) {
        if (!stepA || !stepB) {
            return false;
        }

        if (stepA.index === stepB.index &&
            stepA.id === stepB.id &&
            stepA.type === stepB.type) {
            return true;
        }

        return false;
    }

    /**
     * Create a CFI object from a Range
     * @param {Range} range
     * @param {string | object} base
     * @param {string} [ignoreClass]
     * @returns {object} cfi
     */
    fromRange(range: any, base: any, ignoreClass: any) {
        var cfi: any = {
            range: false,
            base: {},
            path: {},
            start: null,
            end: null,
        };

        var start = range.startContainer;
        var end = range.endContainer;

        var startOffset = range.startOffset;
        var endOffset = range.endOffset;

        var needsIgnoring = false;

        if (ignoreClass) {
            // Tell pathTo if / what to ignore
            needsIgnoring = (start.ownerDocument.querySelector("." + ignoreClass) != null);
        }

        if (typeof base === "string") {
            cfi.base = this.parseComponent(base);
            cfi.spinePos = cfi.base.steps[1].index;
        } else if (typeof base === "object") {
            cfi.base = base;
        }

        if (range.collapsed) {
            if (needsIgnoring) {
                startOffset = this.patchOffset(start, startOffset, ignoreClass);
            }
            cfi.path = this.pathTo(start, startOffset, ignoreClass);
        } else {
            cfi.range = true;

            if (needsIgnoring) {
                startOffset = this.patchOffset(start, startOffset, ignoreClass);
            }

            cfi.start = this.pathTo(start, startOffset, ignoreClass);
            if (needsIgnoring) {
                endOffset = this.patchOffset(end, endOffset, ignoreClass);
            }

            cfi.end = this.pathTo(end, endOffset, ignoreClass);

            // Create a new empty path
            cfi.path = {
                steps: [],
                terminal: null,
            };

            // Push steps that are shared between start and end to the common path
            var len = cfi.start.steps.length;
            var i;

            for (i = 0; i < len; i++) {
                if (this.equalStep(cfi.start.steps[i], cfi.end.steps[i])) {
                    if (i === len - 1) {
                        // Last step is equal, check terminals
                        if (cfi.start.terminal === cfi.end.terminal) {
                            // CFI's are equal
                            cfi.path.steps.push(cfi.start.steps[i]);
                            // Not a range
                            cfi.range = false;
                        }
                    } else {
                        cfi.path.steps.push(cfi.start.steps[i]);
                    }
                } else {
                    break;
                }
            }

            cfi.start.steps = cfi.start.steps.slice(cfi.path.steps.length);
            cfi.end.steps = cfi.end.steps.slice(cfi.path.steps.length);

            // TODO: Add Sanity check to make sure that the end if greater than the start
        }

        return cfi;
    }

    /**
     * Create a CFI object from a Node
     * @param {Node} anchor
     * @param {string | object} base
     * @param {string} [ignoreClass]
     * @returns {object} cfi
     */
    fromNode(anchor: any, base: any, ignoreClass: any) {
        var cfi: any = {
            range: false,
            base: {},
            path: {},
            start: null,
            end: null,
        };

        if (typeof base === "string") {
            cfi.base = this.parseComponent(base);
            cfi.spinePos = cfi.base.steps[1].index;
        } else if (typeof base === "object") {
            cfi.base = base;
        }

        cfi.path = this.pathTo(anchor, null, ignoreClass);

        return cfi;
    }

    filter(anchor: any, ignoreClass: any) {
        var needsIgnoring;
        var sibling; // to join with
        var parent, previousSibling, nextSibling;
        var isText = false;

        if (anchor.nodeType === TEXT_NODE) {
            isText = true;
            parent = anchor.parentNode;
            needsIgnoring = anchor.parentNode.classList.contains(ignoreClass);
        } else {
            isText = false;
            needsIgnoring = anchor.classList.contains(ignoreClass);
        }

        if (needsIgnoring && isText) {
            previousSibling = parent.previousSibling;
            nextSibling = parent.nextSibling;

            // If the sibling is a text node, join the nodes
            if (previousSibling && previousSibling.nodeType === TEXT_NODE) {
                sibling = previousSibling;
            } else if (nextSibling && nextSibling.nodeType === TEXT_NODE) {
                sibling = nextSibling;
            }

            if (sibling) {
                return sibling;
            } else {
                // Parent will be ignored on next step
                return anchor;
            }
        } else if (needsIgnoring && !isText) {
            // Otherwise just skip the element node
            return false;
        } else {
            // No need to filter
            return anchor;
        }
    }

    patchOffset(anchor: any, offset: number, ignoreClass: any): number {
        if (anchor.nodeType != TEXT_NODE) {
            throw new Error("Anchor must be a text node");
        }

        var curr = anchor;
        var totalOffset = offset;

        // If the parent is a ignored node, get offset from it's start
        if (anchor.parentNode.classList.contains(ignoreClass)) {
            curr = anchor.parentNode;
        }

        while (curr.previousSibling) {
            if (curr.previousSibling.nodeType === ELEMENT_NODE) {
                // Originally a text node, so join
                if (curr.previousSibling.classList.contains(ignoreClass)) {
                    totalOffset += curr.previousSibling.textContent.length;
                } else {
                    break; // Normal node, dont join
                }
            } else {
                // If the previous sibling is a text node, join the nodes
                totalOffset += curr.previousSibling.textContent.length;
            }

            curr = curr.previousSibling;
        }

        return totalOffset;
    }

    normalizedMap(children: any, nodeType: number, ignoreClass: any) {
        var output: any = {};
        var prevIndex = -1;
        var i, len = children.length;
        var currNodeType;
        var prevNodeType;

        for (i = 0; i < len; i++) {
            currNodeType = children[i].nodeType;

            // Check if needs ignoring
            if (currNodeType === ELEMENT_NODE &&
                children[i].classList.contains(ignoreClass)) {
                currNodeType = TEXT_NODE;
            }

            if (i > 0 &&
                currNodeType === TEXT_NODE &&
                prevNodeType === TEXT_NODE) {
                // join text nodes
                output[i] = prevIndex;
            } else if (nodeType === currNodeType) {
                prevIndex = prevIndex + 1;
                output[i] = prevIndex;
            }

            prevNodeType = currNodeType;
        }

        return output;
    }

    position(anchor: any) {
        var children, index;
        if (anchor.nodeType === ELEMENT_NODE) {
            children = anchor.parentNode.children;
            if (!children) {
                children = findChildren(anchor.parentNode);
            }
            index = Array.prototype.indexOf.call(children, anchor);
        } else {
            children = this.textNodes(anchor.parentNode);
            index = children.indexOf(anchor);
        }

        return index;
    }

    filteredPosition(anchor: any, ignoreClass: any) {
        var children, index, map;

        if (anchor.nodeType === ELEMENT_NODE) {
            children = anchor.parentNode.children;
            map = this.normalizedMap(children, ELEMENT_NODE, ignoreClass);
        } else {
            children = anchor.parentNode.childNodes;
            // Inside an ignored node
            if (anchor.parentNode.classList.contains(ignoreClass)) {
                anchor = anchor.parentNode;
                children = anchor.parentNode.childNodes;
            }
            map = this.normalizedMap(children, TEXT_NODE, ignoreClass);
        }

        index = Array.prototype.indexOf.call(children, anchor);

        return map[index];
    }

    textNodes(container: any, ignoreClass?: any) {
        return Array.prototype.slice.call(container.childNodes).
            filter(function (node: any) {
                if (node.nodeType === TEXT_NODE) {
                    return true;
                } else if (ignoreClass && node.classList.contains(ignoreClass)) {
                    return true;
                }
                return false;
            });
    }

    /**
     * Check if a string is wrapped with "epubcfi()"
     * @param {string} str
     * @returns {boolean}
     */
    isCfiString(str: any) {
        if (typeof str === "string" &&
            str.indexOf("epubcfi(") === 0 &&
            str[str.length - 1] === ")") {
            return true;
        }

        return false;
    }

    generateChapterComponent(_spineNodeIndex: number, _pos: number, id?: string) {
        var pos = Number(_pos),
            spineNodeIndex = (_spineNodeIndex + 1) * 2,
            cfi = "/" + spineNodeIndex + "/";

        cfi += (pos + 1) * 2;

        if (id) {
            cfi += "[" + id + "]";
        }

        return cfi;
    }

    /**
     * Collapse a CFI Range to a single CFI Position
     * @param {boolean} [toStart=false]
     */
    collapse(toStart?: boolean) {
        if (!this.range) {
            return;
        }

        this.range = false;

        if (toStart) {
            this.path.steps = this.path.steps.concat(this.start.steps);
            this.path.terminal = this.start.terminal;
        } else {
            this.path.steps = this.path.steps.concat(this.end.steps);
            this.path.terminal = this.end.terminal;
        }
    }
}

export default EpubCFI;
