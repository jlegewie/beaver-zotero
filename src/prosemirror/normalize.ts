/**
 * ProseMirror-based HTML normalization for Zotero notes.
 *
 * Performs a true HTML → ProseMirror → HTML roundtrip using Zotero's
 * note-editor schema, producing the exact same canonical HTML that
 * the Zotero note-editor would produce when loading and saving a note.
 *
 * Schema code adapted from zotero/note-editor (AGPL-3.0).
 */

import { DOMParser as ProseMirrorDOMParser } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { getDocument } from './dom';
import { schema } from './schema';
import { Metadata } from './metadata';
import { preprocessHTML, schemaTransform } from './transformer';
import { buildToHTML } from './serializer';

/**
 * Normalize note HTML by roundtripping through ProseMirror's schema.
 * Produces the exact same canonical HTML that Zotero's note-editor produces.
 *
 * @param html - Raw note HTML string (may include wrapper div with data-schema-version)
 * @returns Normalized HTML string
 */
export function normalizeNoteHtml(html: string): string {
    const doc = getDocument();

    // 1. Preprocess HTML (extract metadata, transform legacy content)
    const { html: preprocessedHtml, metadataAttributes } = preprocessHTML(html, doc);

    // 2. Parse metadata
    const schemaVersion = (schema as any).version as number;
    const metadata = new Metadata(schemaVersion);
    metadata.parseAttributes(metadataAttributes);

    // 3. Wire metadata into schema cache (needed by serializeCitationInnerHTML)
    if (!(schema as any).cached) {
        (schema as any).cached = {};
    }
    (schema as any).cached.metadata = metadata;

    // 4. Parse HTML into ProseMirror document
    const container = doc.createElement('div');
    container.innerHTML = preprocessedHtml;
    const fragment = doc.createDocumentFragment();
    while (container.firstChild) {
        fragment.appendChild(container.firstChild);
    }
    const pmDoc = ProseMirrorDOMParser.fromSchema(schema).parse(fragment);

    // 5. Apply schema transforms (strip marks from images, etc.)
    let state = EditorState.create({ doc: pmDoc });
    const tr = schemaTransform(state);
    if (tr) {
        state = state.apply(tr);
    }

    // 6. Serialize back to HTML
    const toHTML = buildToHTML(schema, doc);
    return toHTML(state.doc.content, metadata);
}
