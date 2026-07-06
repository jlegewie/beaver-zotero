/**
 * Extract Zotero item references from citation tags in content.
 *
 * Parses <citation att_id="1-ABC123" page="5"/> tags and returns
 * deduplicated ZoteroItemReference[] for lookup. Skips external
 * references (external_id) since those are resolved from the
 * backend's attachment_manager cache.
 */

import { CITATION_TAG_PATTERN } from '../../../../react/utils/citationPreprocessing';
import { ZoteroItemReference } from '../../../../react/types/zotero';
import { normalizeCitationTag, parseRawCitationAttributes } from '../../../../react/utils/citationGrammar';


/**
 * Result of extracting citation references from content.
 */
export interface ExtractedCitationReferences {
    /** Valid references to look up in Zotero */
    references: ZoteroItemReference[];
    /** Keys that failed format validation (fabricated by the model) */
    invalidKeys: string[];
}


/**
 * Extract unique ZoteroItemReferences from citation tags in content.
 *
 * Also reports invalid keys separately so the backend can provide
 * feedback to the model about fabricated citations.
 *
 * @param content Content (markdown or HTML) containing citation tags
 * @returns Valid references and any invalid keys
 */
export function extractCitationReferences(content: string): ExtractedCitationReferences {
    const seen = new Set<string>();
    const seenInvalid = new Set<string>();
    const references: ZoteroItemReference[] = [];
    const invalidKeys: string[] = [];

    // Reset regex lastIndex for fresh matching
    CITATION_TAG_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = CITATION_TAG_PATTERN.exec(content)) !== null) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
        if (!normalized.ok) {
            if (normalized.reason === 'invalid_zotero_id' && normalized.rawIdentity && !seenInvalid.has(normalized.rawIdentity)) {
                seenInvalid.add(normalized.rawIdentity);
                invalidKeys.push(normalized.rawIdentity);
            }
            continue;
        }
        if (normalized.ref.kind !== 'zotero') continue;

        const key = `${normalized.ref.library_id}-${normalized.ref.zotero_key}`;
        if (seen.has(key)) continue;  // duplicate
        seen.add(key);

        // Validate Zotero key format — track invalid keys separately
        if (!Zotero.Utilities.isValidObjectKey(normalized.ref.zotero_key)) {
            if (!seenInvalid.has(key)) {
                seenInvalid.add(key);
                invalidKeys.push(key);
            }
            continue;
        }

        references.push({
            library_id: normalized.ref.library_id,
            zotero_key: normalized.ref.zotero_key,
            library_ref: normalized.ref.library_ref,
        });
    }

    return { references, invalidKeys };
}
