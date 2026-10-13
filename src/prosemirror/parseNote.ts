/**
 * Parse Zotero note HTML into a ProseMirror document with the note editor's
 * own schema, for code that reads a note's structure (export).
 *
 * The parse matches what the note editor shows: legacy markup is read the way
 * the editor reads it, and anything the schema does not know is dropped the
 * same way. The result is the document's JSON, which carries no ProseMirror
 * or DOM objects and can cross into pure code.
 */

import { DOMParser as ProseMirrorDOMParser } from 'prosemirror-model';
import type { PmNode } from '@beaver/agent-export/runtime';
import { EditorState } from 'prosemirror-state';
import { getDocument } from './dom';
import { restoreLocalHref, shieldLocalHrefAttributes } from './normalize';
import { schema } from './schema';
import { preprocessHTML, schemaTransform } from './transformer';

export interface ParsedNoteHtml {
    doc: PmNode;
    /** `data-*` attributes of the note's wrapper (`data-schema-version`, `data-citation-items`). */
    metadataAttributes: Record<string, string>;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** An HTML attribute value's text: character references decoded, as the DOM reads it. */
function decodeAttributeValue(value: string): string {
    return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (match, hex, decimal, name) => {
        if (name) return NAMED_ENTITIES[name.toLowerCase()];
        const code = hex ? parseInt(hex, 16) : parseInt(decimal, 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

/**
 * Local links (`zotero://`, `file://`) shielded for parsing, restored in the
 * JSON. A shielded href is the attribute as written, so its character
 * references (`&amp;` between query parameters) were never decoded.
 */
function restoreLinks(node: PmNode): void {
    for (const mark of node.marks ?? []) {
        if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
            const restored = restoreLocalHref(mark.attrs.href);
            mark.attrs.href = restored === mark.attrs.href ? restored : decodeAttributeValue(restored);
        }
    }
    for (const child of node.content ?? []) restoreLinks(child);
}

/**
 * Parse note HTML. `prepare` may adjust the parsed DOM before the schema
 * reads it (it gets the container whose children are the note's content).
 */
export function parseNoteHtml(html: string, prepare?: (container: HTMLElement) => void): ParsedNoteHtml {
    const doc = getDocument();
    // Chrome-document innerHTML strips local protocol hrefs; shield them.
    const { html: preprocessed, metadataAttributes } = preprocessHTML(shieldLocalHrefAttributes(html), doc);
    const container = doc.createElement('div');
    container.innerHTML = preprocessed;
    prepare?.(container);
    const fragment = doc.createDocumentFragment();
    while (container.firstChild) fragment.appendChild(container.firstChild);
    let state = EditorState.create({ doc: ProseMirrorDOMParser.fromSchema(schema).parse(fragment) });
    const tr = schemaTransform(state);
    if (tr) state = state.apply(tr);
    const json = state.doc.toJSON() as PmNode;
    restoreLinks(json);
    return { doc: json, metadataAttributes };
}
