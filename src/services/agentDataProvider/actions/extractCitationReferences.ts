/**
 * Extract Zotero item references from citation tags in content.
 *
 * Parses <citation att_id="1-ABC123" page="5"/> tags and returns
 * deduplicated ZoteroItemReference[] for lookup. Skips external
 * references (external_id) since those are resolved from the
 * backend's attachment_manager cache.
 */

import { CITATION_TAG_PATTERN } from '../../../../react/utils/citationPreprocessing';
import { parseCitationAttributes, parseItemReference } from '../../../../react/types/citations';
import { ZoteroItemReference } from '../../../../react/types/zotero';


/**
 * Extract unique ZoteroItemReferences from citation tags in content.
 *
 * @param content Content (markdown or HTML) containing citation tags
 * @returns Deduplicated array of ZoteroItemReference
 */
export function extractCitationReferences(content: string): ZoteroItemReference[] {
    const seen = new Set<string>();
    const references: ZoteroItemReference[] = [];

    // Reset regex lastIndex for fresh matching
    CITATION_TAG_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = CITATION_TAG_PATTERN.exec(content)) !== null) {
        const attrs = parseCitationAttributes(match[1]);

        // Try att_id first (attachment reference), then item_id
        const refStr = attrs.att_id || attrs.item_id;
        if (!refStr) continue;  // external_id only, or no identifier

        const parsed = parseItemReference(refStr);
        if (!parsed) continue;  // invalid format

        const key = `${parsed.libraryID}-${parsed.itemKey}`;
        if (seen.has(key)) continue;  // duplicate

        seen.add(key);
        references.push({
            library_id: parsed.libraryID,
            zotero_key: parsed.itemKey,
        });
    }

    return references;
}
