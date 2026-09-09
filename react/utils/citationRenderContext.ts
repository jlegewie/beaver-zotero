import type { Citation, PartLocation } from '@beaver/agent-core/types/citations';
import type { RenderContextData } from './citationRenderers';
import { store } from '../store';
import { citationMapAtom } from '@beaver/agent-core/citations/atoms';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { CITATION_TAG_PATTERN } from './citationPreprocessing';
import {
    citationIndexCandidateIdsForLocator,
    getPageLocator,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
    type ExternalFileCitationRef,
    type Locator,
} from '@beaver/agent-core/citations/citationGrammar';
import { getCitationPreloadFilePath, preloadPageLabelsForContent } from './pageLabels';
import type { CitationIndexEntry, StructuredExtractResult } from '@beaver/agent-core/extract/schema';
import { UNRESOLVED_LIBRARY_ID } from '../../src/utils/libraryIdentity';
import type { ExternalFileRecord } from '../../src/services/database';

function citationLocationsFromEntries(entries: CitationIndexEntry[]): PartLocation[] {
    const byPage = new Map<number, PartLocation>();
    for (const entry of entries) {
        if (!Number.isInteger(entry.pageIndex) || entry.pageIndex < 0) continue;
        const key = entry.pageIndex;
        const existing = byPage.get(key);
        if (existing) continue;
        byPage.set(key, {
            part_id: entry.id,
            page_idx: entry.pageIndex,
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
): Promise<Record<string, Citation>> {
    const cache = Zotero.Beaver?.documentCache;
    if (!cache) return {};

    const localMap: Record<string, Citation> = {};
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
        // A portable ref whose library isn't available on this device can't be
        // looked up (and would throw); local metadata is only an export
        // enhancement, so skip it and fall back to normal citation rendering.
        if (normalized.ref.library_id === UNRESOLVED_LIBRARY_ID) continue;

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
            const locations = citationLocationsFromEntries(entries);
            if (locations.length === 0) continue;

            const rawTag = match[0];
            const pageLabels = pageLabelsFromEntries(entries);
            localMap[`local:${citationKey}`] = {
                citation_id: `local:${citationKey}`,
                run_id: 'local',
                locations,
                pages: [...new Set(locations
                    .map((location) => location.page_idx)
                    .filter((pageIdx): pageIdx is number => pageIdx !== undefined)
                    .map((pageIdx) => pageIdx + 1)
                )],
                raw_tag: rawTag,
                requested_ref: normalized.ref,
                resolved_ref: normalized.ref,
                citation_type: 'item',
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
 * Resolve the external-file citations in the content against the local
 * `external_files` registry.
 *
 * Returns the absolute path of each cited file that exists on this computer
 * (so the export can offer a clickable file link) and a synthetic citation per
 * cited identity carrying the file's name, content kind and cited pages.
 *
 * That synthetic metadata is what makes the exported reference readable.
 * Backend citation metadata is resolved from a run's message text only, so a
 * file cited inside note content has none — and unlike a library citation
 * there is no Zotero item the export could format from instead, so the
 * reference would render with an empty label. Real backend metadata, when it
 * exists, still wins: `prepareCitationRenderContext` merges it over this map.
 */
export async function resolveExternalFileCitations(content: string): Promise<{
    localPaths: Record<string, string>;
    citationDataMap: Record<string, Citation>;
}> {
    const localPaths: Record<string, string> = {};
    const citationDataMap: Record<string, Citation> = {};

    const db = Zotero.Beaver?.db;
    if (!db) return { localPaths, citationDataMap };

    // One entry per cited identity (ext key + locator), in citation order.
    const citedRefs = new Map<string, { ref: ExternalFileCitationRef; rawTag: string }>();
    const regex = new RegExp(CITATION_TAG_PATTERN.source, CITATION_TAG_PATTERN.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
        if (!normalized.ok || normalized.ref.kind !== 'external_file') continue;

        const citationKey = requestedCitationKey(normalized.ref);
        if (citedRefs.has(citationKey)) continue;
        citedRefs.set(citationKey, { ref: normalized.ref, rawTag: match[0] });
    }

    if (citedRefs.size === 0) return { localPaths, citationDataMap };

    // Each distinct file is read once, however often it is cited.
    const extKeys = new Set([...citedRefs.values()].map(({ ref }) => ref.ext_key));
    const recordsByExtKey = new Map<string, ExternalFileRecord>();
    await Promise.all([...extKeys].map(async (extKey) => {
        try {
            const record = await db.getExternalFileByKey(extKey);
            if (!record) return;
            recordsByExtKey.set(extKey, record);
            if (await IOUtils.exists(record.storedPath).catch(() => false)) {
                localPaths[extKey] = record.storedPath;
            }
        } catch {
            // Both the link and the filename are export enhancements; a file
            // this device knows nothing about falls back to the plain-text
            // citation rendering.
        }
    }));

    for (const [citationKey, { ref, rawTag }] of citedRefs) {
        const record = recordsByExtKey.get(ref.ext_key);
        if (!record) continue;

        const citedPage = Number.parseInt(getPageLocator(ref) ?? '', 10);
        citationDataMap[`local:${citationKey}`] = {
            citation_id: `local:${citationKey}`,
            run_id: 'local',
            citation_type: 'external_file',
            // External files are attachments living outside Zotero; the client
            // branches on content_kind for the per-type icon and for how a
            // cited page reads (an EPUB "page" is a section ordinal).
            item_type: 'attachment',
            content_kind: record.contentKind,
            display_name: record.filename,
            requested_ref: ref,
            resolved_ref: ref,
            raw_tag: rawTag,
            ...(Number.isFinite(citedPage) && citedPage > 0 ? { pages: [citedPage] } : {}),
        };
    }

    return { localPaths, citationDataMap };
}

/**
 * Build the full static-render context for Zotero note export.
 */
export async function prepareCitationRenderContext(
    content: string,
    contextData?: RenderContextData,
): Promise<RenderContextData | undefined> {
    const [pageLabelsByAttachmentId, structuredCitationDataMap, externalFiles] = await Promise.all([
        preloadPageLabelsForContent(content),
        buildLocalCitationDataMapForContent(content),
        resolveExternalFileCitations(content),
    ]);

    const localCitationDataMap = {
        ...structuredCitationDataMap,
        ...externalFiles.citationDataMap,
    };
    const externalFileLocalPaths = externalFiles.localPaths;

    const hasPageLabels = Object.keys(pageLabelsByAttachmentId).length > 0;
    const hasLocalCitations = Object.keys(localCitationDataMap).length > 0;
    const hasExternalFilePaths = Object.keys(externalFileLocalPaths).length > 0;
    if (!contextData && !hasPageLabels && !hasLocalCitations && !hasExternalFilePaths) return undefined;

    const baseContext: RenderContextData = contextData ?? {
        citationDataMap: store.get(citationMapAtom),
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
        externalFileLocalPaths: {
            ...(baseContext.externalFileLocalPaths ?? {}),
            ...externalFileLocalPaths,
        },
    };
}
