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

const LOCAL_HREF_SHIELD_PREFIX = 'https://zotero-cite.invalid/';

function shieldLocalHrefAttributes(html: string): string {
    return html.replace(
        /href="((?:zotero|file):\/\/[^"]*)"/g,
        (_match, href) => `href="${LOCAL_HREF_SHIELD_PREFIX}${encodeURIComponent(href)}"`
    );
}

function restoreLocalHrefAttributes(html: string): string {
    return html.replace(
        new RegExp(`href="${LOCAL_HREF_SHIELD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^"]*)"`, 'g'),
        (match, encodedHref) => {
            try {
                return `href="${decodeURIComponent(encodedHref)}"`;
            } catch {
                return match;
            }
        }
    );
}

/**
 * Normalize note HTML by roundtripping through ProseMirror's schema.
 * Produces the exact same canonical HTML that Zotero's note-editor produces.
 *
 * @param html - Raw note HTML string (may include wrapper div with data-schema-version)
 * @returns Normalized HTML string
 */
export function normalizeNoteHtml(html: string): string {
    const doc = getDocument();

    // 1. Chrome-document innerHTML strips local protocol hrefs. Preserve the
    //    Zotero and file links that the note editor itself supports.
    const shieldedInput = shieldLocalHrefAttributes(html);

    // 2. Preprocess HTML (extract metadata, transform legacy content)
    const { html: preprocessedHtml, metadataAttributes } = preprocessHTML(shieldedInput, doc);

    // 3. Parse metadata
    const schemaVersion = (schema as any).version as number;
    const metadata = new Metadata(schemaVersion);
    metadata.parseAttributes(metadataAttributes);

    // 4. Wire metadata into schema cache (needed by serializeCitationInnerHTML)
    if (!(schema as any).cached) {
        (schema as any).cached = {};
    }
    (schema as any).cached.metadata = metadata;

    // 5. Parse HTML into ProseMirror document
    const container = doc.createElement('div');
    container.innerHTML = preprocessedHtml;
    const fragment = doc.createDocumentFragment();
    while (container.firstChild) {
        fragment.appendChild(container.firstChild);
    }
    const pmDoc = ProseMirrorDOMParser.fromSchema(schema).parse(fragment);

    // 6. Apply schema transforms (strip marks from images, etc.)
    let state = EditorState.create({ doc: pmDoc });
    const tr = schemaTransform(state);
    if (tr) {
        state = state.apply(tr);
    }

    // 7. Serialize back to HTML
    const toHTML = buildToHTML(schema, doc);
    return restoreLocalHrefAttributes(toHTML(state.doc.content, metadata));
}
