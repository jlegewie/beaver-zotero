/**
 * HTML serialization/deserialization for the Zotero note ProseMirror schema.
 * Adapted from zotero/note-editor src/core/schema/utils.js (AGPL-3.0).
 *
 * Key adaptations:
 * - Parameterized with Document (no global `document` dependency)
 * - Imports HIGHLIGHT_COLORS from ./colors (not ./index) to break circular dep
 * - Dropped buildClipboardSerializer (not needed for normalization)
 */

import { DOMParser as ProseMirrorDOMParser, DOMSerializer, type Fragment, type Node as PMNode, type Schema, type Slice } from 'prosemirror-model';
import { encodeObject, formatCitationItem } from './helpers';
import type { Metadata } from './metadata';

// Note: TinyMCE is automatically removing div nodes without text and triggering immediate update/sync

export function buildToHTML(schema: Schema, doc: Document) {
    return function (content: Fragment, metadata: Metadata): string {
        // Return an empty string if note is empty to allow Zotero to
        // determine if note is empty. Though, this won't allow container
        // metadata to survive after note is cleared and then re-opened
        if (content.childCount === 1
            && content.firstChild!.isTextblock
            && content.firstChild!.content.size === 0) {
            return '';
        }

        const fragment = DOMSerializer.fromSchema(schema).serializeFragment(content, { document: doc });
        const htmlDoc = doc.implementation.createHTMLDocument('New');
        const tmp = htmlDoc.body;

        const container = htmlDoc.createElement('div');

        const metadataAttributes = metadata.serializeAttributes();
        const keys = Object.keys(metadataAttributes).sort();
        for (const key of keys) {
            const value = metadataAttributes[key];
            container.setAttribute(key, value);
        }

        tmp.append(container);
        container.append(fragment);

        const textNodes = [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre'
        ];

        const blockNodes = [
            'ol', 'ul', 'li', 'hr', 'blockquote', 'table', 'th', 'tr', 'td', 'thead', 'tbody', 'tfoot'
        ];

        const allElements = tmp.querySelectorAll([...textNodes, ...blockNodes].join(','));
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            if (blockNodes.includes(el.nodeName.toLowerCase())) {
                el.insertBefore(htmlDoc.createTextNode('\n'), el.firstChild);
            }
            el.parentNode!.insertBefore(htmlDoc.createTextNode('\n'), el.nextSibling);
        }

        const liElements = tmp.querySelectorAll('li');
        for (let i = 0; i < liElements.length; i++) {
            const li = liElements[i] as HTMLElement;
            if (li.children.length === 1
                && li.firstElementChild!.nodeName === 'P') {
                const firstEl = li.firstElementChild!;
                const children = Array.from(firstEl.childNodes) as globalThis.Node[];
                firstEl.replaceWith(...children);
            }
        }

        // Decreasing schema version number if not using the new math features
        if ((schema as any).version === 9
            && !tmp.querySelectorAll('pre.math, span.math').length) {
            container.setAttribute('data-schema-version', '8');
        }

        // Decrease schema version number if not using underline annotations
        if ((schema as any).version === 10
            && !tmp.querySelector('span.underline')) {
            container.setAttribute('data-schema-version', '9');
        }

        let html = tmp.innerHTML.trim();
        // Normalize text by precomposing characters and accents into single composed characters
        // to prevent indexing issues
        html = html.normalize('NFC');
        return html;
    };
}

export function buildFromHTML(schema: Schema, doc: Document) {
    return function (html: string, slice?: boolean): PMNode | Slice {
        const domNode = doc.createElement('div');
        domNode.innerHTML = html;
        const fragment = doc.createDocumentFragment();
        while (domNode.firstChild) {
            fragment.appendChild(domNode.firstChild);
        }
        if (slice) {
            return ProseMirrorDOMParser.fromSchema(schema).parseSlice(fragment);
        }
        else {
            return ProseMirrorDOMParser.fromSchema(schema).parse(fragment);
        }
    };
}

export function serializeCitationInnerHTML(node: PMNode): any[] {
    const children: any[] = ['('];
    try {
        const citation = JSON.parse(JSON.stringify(node.attrs.citation));
        (node.type.schema as any).cached.metadata.fillCitationItemsWithData(citation.citationItems);
        citation.citationItems.forEach((citationItem: any, index: number, array: any[]) => {
            if (citationItem.itemData) {
                children.push(['span', { class: 'citation-item' }, formatCitationItem(citationItem)]);
                if (index !== array.length - 1) {
                    children.push('; ');
                }
            }
        });
    }
    catch (e) {
        // Intentionally swallow
    }
    children.push(')');
    return children;
}
