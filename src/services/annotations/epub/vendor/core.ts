/* eslint-disable */
/**
 * Vendored helpers from epub.js `src/utils/core.js`.
 *
 * Source: https://github.com/zotero/epub.js (fork used by the Zotero reader),
 * pinned commit a6139d586b66d404f3da2b846598960c0394afc5 — the reader's
 * `epubjs/epub.js` submodule revision. Kept byte-for-byte (typed only) so the
 * vendored {@link ./epubcfi} generates CFIs identical to the reader's.
 *
 * Only the four helpers EpubCFI's generation path needs are included. epub.js
 * is BSD-2-Clause licensed. Keep in sync with the reader's pinned commit.
 */

/** True when `n` is a finite number (or numeric string). */
export function isNumber(n: any): boolean {
    return !isNaN(parseFloat(n)) && isFinite(n);
}

/** Copy own property descriptors from each source onto `target`. */
export function extend(target: any, ...sources: any[]): any {
    sources.forEach(function (source) {
        if (!source) return;
        Object.getOwnPropertyNames(source).forEach(function (propName) {
            Object.defineProperty(
                target,
                propName,
                Object.getOwnPropertyDescriptor(source, propName)!,
            );
        });
    });
    return target;
}

/** Internal `[[Class]]` tag, e.g. "Range", "Array". */
export function type(obj: any): string {
    return Object.prototype.toString.call(obj).slice(8, -1);
}

/** Element children of `el` (fallback for nodes without `.children`). */
export function findChildren(el: any): any[] {
    var result = [];
    var childNodes = el.childNodes;
    for (var i = 0; i < childNodes.length; i++) {
        let node = childNodes[i];
        if (node.nodeType === 1) {
            result.push(node);
        }
    }
    return result;
}
