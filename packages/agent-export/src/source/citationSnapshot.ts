/**
 * Capture the citation metadata an export source needs.
 *
 * A client holds metadata for every citation of the open thread; the export
 * carries only what its own citation tags look up, so the payload handed to the
 * host stays proportional to the exported content.
 */

import type { Citation } from '@beaver/agent-core/types/citations';
import {
    baseCitationKey,
    CITATION_TAG_PATTERN,
    externalCompatKey,
    getRequestedRef,
    getResolvedRef,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
    unwrapBacktickedCitations,
    type CitationRef,
} from '@beaver/agent-core/citations/citationGrammar';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { CitationSnapshot, ExportSourceBlock } from '../types';

/** Every citation tag in the blocks, as parsed identities and lookup keys. */
export function collectCitationTags(blocks: ExportSourceBlock[]): Array<{ ref: CitationRef | null; keys: string[] }> {
    const tags: Array<{ ref: CitationRef | null; keys: string[] }> = [];
    for (const block of blocks) {
        // Tool activity has no tags; a prompt is plain text, so it has none either.
        if (block.type === 'activity' || block.type === 'user') continue;
        const pattern = new RegExp(CITATION_TAG_PATTERN.source, CITATION_TAG_PATTERN.flags);
        for (const match of unwrapBacktickedCitations(block.markdown).matchAll(pattern)) {
            const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] ?? ''));
            if (normalized.ok) {
                const ref = normalized.ref;
                const keys = [requestedCitationKey(ref), baseCitationKey(ref)];
                if (ref.kind === 'external') keys.push(externalCompatKey(ref.external_id, ref.loc), externalCompatKey(ref.external_id));
                tags.push({ ref, keys });
            } else {
                const keys = [normalized.requestedKey, normalized.rawIdentity ? `invalid:${normalized.rawIdentity}` : undefined]
                    .filter((key): key is string => !!key);
                tags.push({ ref: null, keys });
            }
        }
    }
    return tags;
}

export interface CitationSnapshotInput {
    blocks: ExportSourceBlock[];
    citationsByKey: Record<string, Citation>;
    externalReferences: Record<string, ExternalReference>;
    externalItemMapping: Record<string, ZoteroItemReference | null>;
    pageLabelsByAttachmentId?: Record<number, Record<number, string>>;
}

/** The subset of a client's citation state the blocks' tags reference. */
export function buildCitationSnapshot(input: CitationSnapshotInput): CitationSnapshot {
    const citationsByKey: Record<string, Citation> = {};
    const externalIds = new Set<string>();

    for (const { ref, keys } of collectCitationTags(input.blocks)) {
        if (ref?.kind === 'external') externalIds.add(ref.external_id);
        for (const key of keys) {
            const citation = input.citationsByKey[key];
            if (!citation) continue;
            citationsByKey[key] = citation;
            for (const metaRef of [getRequestedRef(citation), getResolvedRef(citation)]) {
                if (metaRef?.kind === 'external') externalIds.add(metaRef.external_id);
            }
        }
    }

    const externalReferences: Record<string, ExternalReference> = {};
    const externalItemMapping: Record<string, ZoteroItemReference | null> = {};
    for (const id of externalIds) {
        if (input.externalReferences[id]) externalReferences[id] = input.externalReferences[id];
        if (id in input.externalItemMapping) externalItemMapping[id] = input.externalItemMapping[id];
    }

    return {
        citationsByKey,
        externalReferences,
        externalItemMapping,
        pageLabelsByAttachmentId: input.pageLabelsByAttachmentId ?? {},
    };
}
