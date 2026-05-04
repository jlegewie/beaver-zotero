/**
 * HTML preprocessing and schema transforms for the Zotero note ProseMirror schema.
 * Adapted from zotero/note-editor src/core/schema/transformer.js (AGPL-3.0).
 *
 * Key adaptations:
 * - preprocessHTML parameterized with Document (no global `document`)
 * - Node.ELEMENT_NODE replaced with literal 1
 */

import type { EditorState, Transaction } from 'prosemirror-state';

const ELEMENT_NODE = 1;

export function preprocessHTML(html: string, doc: Document): { html: string; metadataAttributes: Record<string, string> } {
    const metadataAttributes: Record<string, string> = {};
    const container = doc.createElement('body');
    container.innerHTML = html;

    const metadataNode = container.querySelector('div[data-schema-version]');
    if (metadataNode) {
        const attrs = metadataNode.attributes;
        for (let i = 0; i < attrs.length; i++) {
            const attr = attrs[i];
            // TinyMCE keeps only data attributes
            if (attr.name.startsWith('data-')) {
                metadataAttributes[attr.name] = attr.value;
            }
        }
    }

    function createLink(url: string): HTMLAnchorElement {
        const a = doc.createElement('a');
        a.href = url;
        a.appendChild(doc.createTextNode(url));
        return a;
    }

    function createImage(src: string): HTMLImageElement {
        const img = doc.createElement('img');
        img.src = src;
        return img;
    }

    function walk(elm: Node): void {
        let node: Node | null;
        for (node = elm.firstChild; node; node = node.nextSibling) {
            if (node.nodeType === ELEMENT_NODE) {
                const el = node as HTMLElement;
                if (el.style) {
                    if (el.style.backgroundImage) {
                        const matched = el.style.backgroundImage.match(/url\(["']?([^"']*)["']?\)/);
                        if (matched && /^(https?|data):/.test(matched[1])) {
                            el.parentElement!.insertBefore(createImage(matched[1]), el);
                        }
                    }
                }

                if (el.nodeName !== 'IMG' && el.getAttribute('src')) {
                    el.parentElement!.insertBefore(createLink(el.getAttribute('src')!), el);
                }
                walk(el);
            }
        }
    }

    walk(container);

    return { html: container.innerHTML, metadataAttributes };
}

// Additional transformations that can't be described with schema alone
export function schemaTransform(state: EditorState): Transaction | null {
    const { tr } = state;
    let updated = false;
    state.doc.descendants((node, pos) => {
        // Do not allow to be wrapped in any mark
        if (['image'].includes(node.type.name) && node.marks.length) {
            tr.setNodeMarkup(pos, null, node.attrs, []);
            updated = true;
        }
        // Force inline code to have only plain text
        else if (!node.isText && node.marks.find(mark => mark.type.name === 'code')) {
            tr.removeMark(pos, pos + 1, state.schema.marks.code);
            updated = true;
        }
    });
    return updated ? tr : null;
}
