/**
 * Central ProseMirror schema for Zotero notes.
 * Adapted from zotero/note-editor src/core/schema/index.js (AGPL-3.0).
 *
 * Creates the Schema instance, sets the version, and re-exports
 * key constants. buildToHTML/buildFromHTML are NOT re-exported here
 * to avoid a circular dependency — call them directly from serializer.ts.
 */

import { Schema } from 'prosemirror-model';
import nodes from './nodes';
import marks from './marks';

const schema = new Schema({ nodes, marks });

// Update in Zotero 'editorInstance.js' as well!
(schema as any).version = 10;

// Note: Upgrade schema version if introducing new quotation marks
const QUOTATION_MARKS = ["'", '"', '\u201c', '\u201d', '\u2018', '\u2019', '\u201e', '\u00ab', '\u00bb'];

export {
    nodes,
    marks,
    schema,
    QUOTATION_MARKS,
};
export { TEXT_COLORS, HIGHLIGHT_COLORS } from './colors';
