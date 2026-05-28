import type { CitationData, CitationPart } from '../types/citations';
import type { RenderContextData } from './citationRenderers';
import { store } from '../store';
import { citationDataMapAtom } from '../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../atoms/externalReferences';
import { CITATION_TAG_PATTERN } from './citationPreprocessing';
import {
    citationIndexCandidateIdsForLocator,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
    type Locator,
} from './citationGrammar';
import { getCitationPreloadFilePath, preloadPageLabelsForContent } from './pageLabels';
import type { CitationIndexEntry, StructuredExtractResult } from '../../src/beaver-extract/schema/schema';

function citationPartsFromEntries(entries: CitationIndexEntry[]): CitationPart[] {
    const byPage = new Map<number, CitationPart>();
    for (const entry of entries) {
        if (!Number.isInteger(entry.pageIndex) || entry.pageIndex < 0) continue;
        const key = entry.pageIndex;
        const existing = byPage.get(key);
        if (existing) continue;
        byPage.set(key, {
            part_id: entry.id,
            locations: [{ page_idx: entry.pageIndex }],
        });
    }
    return [...byPage.values()];
}

function pageLabelsFromEntries(entries: CitationIndexEntry[]): Record<number, string> | undefined {
    const labels: Record<number, string> = {};
    for (const entry of entries) {
        if (!Number.isInteger(entry.pageIndex) || !entry.pageLabel) continue;
        labels[entry.pageIndex] = entry.pageLabel;
    }
    return Object.keys(labels).length > 0 ? labels : undefined;
}

function resolveEntriesFromStructuredResult(
    result: StructuredExtractResult,
    locator: Locator,
): CitationIndexEntry[] {
    const index = result.document.citationIndex ?? {};
    const entries: CitationIndexEntry[] = [];
    const seen = new Set<string>();
    for (const id of citationIndexCandidateIdsForLocator(locator)) {
        const entry = index[id];
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
    }
    return entries;
}

/**
 * Builds local citation metadata for non-page locators using the structured
 * extraction cache. Tool-call note content is not always covered by backend
 * citation metadata, so note export needs this local page bridge.
 */
export async function buildLocalCitationDataMapForContent(
    content: string,
): Promise<Record<string, CitationData>> {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return {};

    const localMap: Record<string, CitationData> = {};
    const seen = new Set<string>();
    const structuredResultsByFile = new Map<string, Promise<StructuredExtractResult | null>>();
    const regex = new RegExp(CITATION_TAG_PATTERN.source, CITATION_TAG_PATTERN.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const rawAttrs = parseRawCitationAttributes(match[1] || '');
        const normalized = normalizeCitationTag(rawAttrs);
        if (!normalized.ok || normalized.ref.kind !== 'zotero' || !normalized.ref.loc) continue;
        if (normalized.ref.loc.kind === 'page') continue;

        const citationKey = requestedCitationKey(normalized.ref);
        if (seen.has(citationKey)) continue;
        seen.add(citationKey);

        try {
            const item = Zotero.Items.getByLibraryAndKey(
                normalized.ref.library_id,
                normalized.ref.zotero_key,
            );
            if (!item || typeof item === 'boolean') continue;

            const preloadPath = await getCitationPreloadFilePath(item);
            if (!preloadPath) continue;

            const cacheKey = `${preloadPath.item.libraryID}:${preloadPath.item.key}:${preloadPath.filePath}`;
            let resultPromise = structuredResultsByFile.get(cacheKey);
            if (!resultPromise) {
                resultPromise = cache.getResult(
                    {
                        libraryId: preloadPath.item.libraryID,
                        zoteroKey: preloadPath.item.key,
                    },
                    'structured',
                    preloadPath.filePath,
                ).then((result) => (
                    result && result.mode === 'structured' ? result : null
                ));
                structuredResultsByFile.set(cacheKey, resultPromise);
            }
            const result = await resultPromise;
            if (!result) continue;

            const entries = resolveEntriesFromStructuredResult(result, normalized.ref.loc);
            const parts = citationPartsFromEntries(entries);
            if (parts.length === 0) continue;

            const rawTag = match[0];
            const pageLabels = pageLabelsFromEntries(entries);
            localMap[`local:${citationKey}`] = {
                citation_id: `local:${citationKey}`,
                run_id: 'local',
                parts,
                pages: [...new Set(parts.flatMap((part) =>
                    (part.locations || []).map((location) => location.page_idx + 1)
                ))],
                library_id: normalized.ref.library_id,
                zotero_key: normalized.ref.zotero_key,
                raw_tag: rawTag,
                requested_ref: normalized.ref,
                type: 'item',
                parentKey: null,
                icon: null,
                name: null,
                citation: null,
                formatted_citation: null,
                url: null,
                numericCitation: null,
                ...(pageLabels ? { page_labels: pageLabels } : {}),
            };
        } catch {
            // Local metadata is an export enhancement; unresolved locators fall
            // back to the normal citation rendering path.
        }
    }

    return localMap;
}

/**
 * Build the full static-render context for Zotero note export.
 */
export async function prepareCitationRenderContext(
    content: string,
    contextData?: RenderContextData,
): Promise<RenderContextData | undefined> {
    const [pageLabelsByAttachmentId, localCitationDataMap] = await Promise.all([
        preloadPageLabelsForContent(content),
        buildLocalCitationDataMapForContent(content),
    ]);

    const hasPageLabels = Object.keys(pageLabelsByAttachmentId).length > 0;
    const hasLocalCitations = Object.keys(localCitationDataMap).length > 0;
    if (!contextData && !hasPageLabels && !hasLocalCitations) return undefined;

    const baseContext: RenderContextData = contextData ?? {
        citationDataMap: store.get(citationDataMapAtom),
        externalMapping: store.get(externalReferenceItemMappingAtom),
        externalReferencesMap: store.get(externalReferenceMappingAtom),
    };

    return {
        ...baseContext,
        citationDataMap: {
            ...localCitationDataMap,
            ...(baseContext.citationDataMap ?? {}),
        },
        pageLabelsByAttachmentId: {
            ...(baseContext.pageLabelsByAttachmentId ?? {}),
            ...pageLabelsByAttachmentId,
        },
    };
}
