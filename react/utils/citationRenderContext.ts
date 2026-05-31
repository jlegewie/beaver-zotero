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
import { createAnnotationHTML, createNoteLinkHTML } from '../../src/utils/zoteroUtils';
import type { ReferenceHtmlByCitationKey } from '../atoms/citations';

/**
 * Pre-resolve raw note HTML for note/annotation references in note-export
 * content, keyed by "libraryID-itemKey".
 *
 * Notes render as `zotero://select` hyperlinks (sync) and annotations as native
 * highlight embeds (async, since the parent attachment must be loaded). The
 * export render path (`ZoteroCitation`) is synchronous, so this map is built
 * up-front here and read synchronously during render. Image/ink annotations and
 * any reference that fails to resolve are skipped — those fall through to the
 * normal citation rendering.
 */
export async function buildReferenceHtmlForContent(
    content: string,
): Promise<ReferenceHtmlByCitationKey> {
    const referenceHtmlByCitationKey: ReferenceHtmlByCitationKey = {};
    const seen = new Set<string>();
    const regex = new RegExp(CITATION_TAG_PATTERN.source, CITATION_TAG_PATTERN.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
        if (!normalized.ok || normalized.ref.kind !== 'zotero') continue;

        const itemId = `${normalized.ref.library_id}-${normalized.ref.zotero_key}`;
        if (seen.has(itemId)) continue;
        seen.add(itemId);

        const item = Zotero.Items.getByLibraryAndKey(normalized.ref.library_id, normalized.ref.zotero_key);
        if (!item || typeof item === 'boolean') continue;

        try {
            if (item.isNote()) {
                referenceHtmlByCitationKey[itemId] = createNoteLinkHTML(item);
            } else if (item.isAnnotation()) {
                referenceHtmlByCitationKey[itemId] = await createAnnotationHTML(item);
            }
        } catch {
            // Reference can't be embedded (e.g. image/ink annotation); fall back
            // to the normal citation rendering path.
        }
    }

    return referenceHtmlByCitationKey;
}

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
    const [pageLabelsByAttachmentId, localCitationDataMap, referenceHtmlByCitationKey] = await Promise.all([
        preloadPageLabelsForContent(content),
        buildLocalCitationDataMapForContent(content),
        buildReferenceHtmlForContent(content),
    ]);

    const hasPageLabels = Object.keys(pageLabelsByAttachmentId).length > 0;
    const hasLocalCitations = Object.keys(localCitationDataMap).length > 0;
    const hasReferenceHtml = Object.keys(referenceHtmlByCitationKey).length > 0;
    if (!contextData && !hasPageLabels && !hasLocalCitations && !hasReferenceHtml) return undefined;

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
        referenceHtmlByCitationKey: {
            ...(baseContext.referenceHtmlByCitationKey ?? {}),
            ...referenceHtmlByCitationKey,
        },
    };
}
