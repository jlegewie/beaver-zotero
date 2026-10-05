/**
 * The pieces of a word-processor document that Zotero's Word plugin reads:
 * citation and bibliography field codes, and the document preferences stored
 * as custom document properties.
 *
 * Format notes (verified against Zotero's integration code and real documents):
 * - A citation field code is ` ADDIN ZOTERO_ITEM CSL_CITATION {json} `, where
 *   the JSON is what Zotero's `Citation.toJSON` writes.
 * - `plainCitation` must equal the field's visible text, or a refresh asks
 *   whether to keep a "modified" citation. `formattedCitation` is the
 *   processor's RTF for the same citation, which makes a refresh a no-op.
 * - Every item needs `uris`: Zotero's loader dereferences it unconditionally.
 *   Items with no library item carry one stable URI per work, which Zotero
 *   uses to keep repeated citations of the work as one embedded item.
 *   `itemData` keeps the citation working for readers who do not have the item.
 * - Document preferences are Zotero's XML DocumentData, split into 255
 *   character `ZOTERO_PREF_n` properties.
 */

import type { FormattedCluster } from '../types';

const CSL_CITATION_SCHEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json';
const PREF_CHUNK_LENGTH = 255;

export const BIBLIOGRAPHY_FIELD_CODE = ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY ';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random identifier like the ones Zotero assigns to citations and sessions. */
export function randomId(length = 8): string {
    let id = '';
    for (let i = 0; i < length; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    return id;
}

/** The citation JSON Zotero stores in a field code. */
export function citationFieldJson(cluster: FormattedCluster, citationID: string): Record<string, unknown> {
    return {
        citationID,
        properties: {
            formattedCitation: cluster.rtf ?? cluster.plain,
            plainCitation: cluster.plain,
            noteIndex: cluster.noteIndex,
        },
        citationItems: cluster.items.map(item => ({
            id: item.id,
            uris: item.uris,
            itemData: item.itemData,
            ...(item.locator ? { locator: item.locator, label: item.label ?? 'page' } : {}),
        })),
        schema: CSL_CITATION_SCHEMA,
    };
}

/** The field instruction of a citation. */
export function citationFieldCode(cluster: FormattedCluster, citationID: string = randomId()): string {
    return ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(citationFieldJson(cluster, citationID))} `;
}

/** Split document preferences into `ZOTERO_PREF_n` custom document properties. */
export function documentPreferenceProperties(documentData: string): Array<{ name: string; value: string }> {
    const properties: Array<{ name: string; value: string }> = [];
    for (let i = 0; i * PREF_CHUNK_LENGTH < documentData.length; i++) {
        properties.push({
            name: `ZOTERO_PREF_${i + 1}`,
            value: documentData.slice(i * PREF_CHUNK_LENGTH, (i + 1) * PREF_CHUNK_LENGTH),
        });
    }
    return properties;
}
