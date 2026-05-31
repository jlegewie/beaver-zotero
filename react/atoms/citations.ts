import { atom } from 'jotai';
import { getDisplayNameFromItem, getReferenceFromItem } from '../utils/sourceUtils';
import { createZoteroURI } from "../utils/zoteroURI";
import { logger } from '../../src/utils/logger';
import {
    CitationMetadata,
    CitationData,
    isExternalCitation,
    getCitationPages,
} from '../types/citations';
import {
    baseCitationKey,
    type CitationRef,
    externalCompatKey,
    getRequestedRef,
    getResolvedRef,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
} from '../utils/citationGrammar';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { externalReferenceMappingAtom, formatExternalCitation } from './externalReferences';
import { getPref, setPref } from '../../src/utils/prefs';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { isFirstRunVisibleAtom } from './firstRun';
import { activeRunAtom, threadRunsAtom } from '../agents/atoms';
import { isFirstRunOrigin } from '../agents/types';

/**
 * Thread-scoped citation marker assignment.
 * 
 * Maps citation keys to numeric markers (e.g., "1", "2", "3").
 * This ensures consistent markers across streaming and post-metadata states:
 * - Markers are assigned in render order during streaming (first appearance = "1")
 * - Same citation key always gets the same marker
 * - Resets when thread changes (via resetCitationMarkersAtom)
 */
export const citationKeyToMarkerAtom = atom<Record<string, string>>({});

function getNextCitationMarker(current: Record<string, string>): string {
    const maxMarker = Object.values(current).reduce((max, marker) => {
        const parsed = parseInt(marker, 10);
        return Number.isFinite(parsed) && parsed > max ? parsed : max;
    }, 0);
    return (maxMarker + 1).toString();
}

function getEarliestExistingMarker(current: Record<string, string>, keys: string[]): string | undefined {
    const markers = keys
        .map((key) => current[key])
        .filter((marker): marker is string => !!marker);
    if (markers.length === 0) return undefined;

    const numericMarkers = markers
        .map((marker) => parseInt(marker, 10))
        .filter((marker) => Number.isFinite(marker));
    if (numericMarkers.length === 0) return markers[0];

    return Math.min(...numericMarkers).toString();
}

/**
 * Get or assign a numeric marker for a citation key.
 * Returns the existing marker if already assigned, otherwise assigns the next number.
 */
export const getOrAssignCitationMarkerAtom = atom(
    null,
    (get, set, citationKey: string): string => {
        const current = get(citationKeyToMarkerAtom);
        if (current[citationKey]) {
            return current[citationKey];
        }
        const nextMarker = getNextCitationMarker(current);
        set(citationKeyToMarkerAtom, { ...current, [citationKey]: nextMarker });
        return nextMarker;
    }
);

/**
 * Lookup a citation marker without assigning (read-only).
 * Returns undefined if the citation key hasn't been assigned a marker yet.
 */
export const getCitationMarkerAtom = atom(
    (get) => (citationKey: string): string | undefined => {
        return get(citationKeyToMarkerAtom)[citationKey];
    }
);

/**
 * Ensure a group of citation base keys all resolve to the same marker.
 */
export const aliasCitationMarkerKeysAtom = atom(
    null,
    (get, set, keys: string[]): string | null => {
        const uniqueKeys = [...new Set(keys.filter(Boolean))];
        if (uniqueKeys.length === 0) return null;

        const current = get(citationKeyToMarkerAtom);
        const existingMarker = getEarliestExistingMarker(current, uniqueKeys);
        const marker = existingMarker || getNextCitationMarker(current);
        const next = { ...current };
        for (const key of uniqueKeys) {
            next[key] = marker;
        }
        set(citationKeyToMarkerAtom, next);
        return marker;
    }
);

/**
 * PDF page labels keyed by Zotero attachment item ID, then 0-based page index.
 */
export type PageLabelsByAttachmentId = Record<number, Record<number, string>>;

export const pageLabelsByAttachmentIdAtom = atom<PageLabelsByAttachmentId>({});

/**
 * Pre-resolved raw note HTML for note/annotation references during Zotero note
 * export, keyed by "libraryID-itemKey". Annotation embeds are async to build,
 * so they are resolved up-front (in `prepareCitationRenderContext`) and read
 * synchronously by `ZoteroCitation`'s export branch.
 */
export type ReferenceHtmlByCitationKey = Record<string, string>;
export const referenceHtmlByCitationKeyAtom = atom<ReferenceHtmlByCitationKey>({});

/**
 * Reset citation markers and thread-scoped page-label render state. Called when
 * creating a new thread or loading an existing one.
 */
export const resetCitationMarkersAtom = atom(
    null,
    (_get, set) => {
        set(citationKeyToMarkerAtom, {});
        set(pageLabelsByAttachmentIdAtom, {});
    }
);

export const mergePageLabelsByAttachmentIdAtom = atom(
    null,
    (get, set, labelsByAttachmentId: PageLabelsByAttachmentId) => {
        const entries = Object.entries(labelsByAttachmentId).filter(([, labels]) => (
            labels && Object.keys(labels).length > 0
        ));
        if (entries.length === 0) return;

        const current = get(pageLabelsByAttachmentIdAtom);
        const next: PageLabelsByAttachmentId = { ...current };
        let changed = false;

        for (const [attachmentId, labels] of entries) {
            const id = Number(attachmentId);
            const existing = current[id];
            if (existing && JSON.stringify(existing) === JSON.stringify(labels)) continue;
            next[id] = { ...labels };
            changed = true;
        }

        if (changed) {
            set(pageLabelsByAttachmentIdAtom, next);
        }
    }
);


/*
 * Citation metadata
 *
 * citationMetadataAtom are all citations metadata for the current thread.
 * Populated by (a) "citation_metadata" events during streaming, and (b)
 * citations in message metadata.
 * 
 * They are used to display the citations in the assistant message footer.
 * 
 */
export const citationMetadataAtom = atom<CitationMetadata[]>([]);


/**
 * Citations by run ID
 *
 * citationsByRunIdAtom is a Record mapping run_id to CitationMetadata[].
 */
export const citationsByRunIdAtom = atom<Record<string, CitationMetadata[]>>(
    (get) => {
        const citations = get(citationMetadataAtom);
        const citationsByRunId: Record<string, CitationMetadata[]> = {};
        for (const citation of citations) {
            if (!citationsByRunId[citation.run_id]) {
                citationsByRunId[citation.run_id] = [];
            }
            citationsByRunId[citation.run_id].push(citation);
        }
        return citationsByRunId;
    }
);


/*
 * Citation data mapping for UI display
 *
 * citationDataMapAtom is a Record mapping citation_id to CitationData.
 * 
 * The atom is updated by updateCitationDataAtom, which is called on
 * "citation_metadata" events and when loading previous threads.
 */
export const citationDataMapAtom = atom<Record<string, CitationData>>({});

/**
 * Extract the identifier value from a raw citation tag for fallback lookup.
 * This is used for invalid citations where library_id/zotero_key couldn't be parsed.
 * 
 * @param rawTag The original citation tag, e.g., '<citation att_id="garbage"/>'
 * @returns Fallback key like "invalid:garbage" or null if no ID found
 */
function getInvalidCitationFallbackKey(rawTag: string): string | null {
    const match = rawTag.match(/^<citation\b([^>]*)/i);
    if (!match) return null;
    const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
    return !normalized.ok && normalized.rawIdentity ? `invalid:${normalized.rawIdentity}` : null;
}

function addCitationKeys(keys: Set<string>, citation: CitationMetadata) {
    for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
        if (!ref) continue;
        keys.add(requestedCitationKey(ref));
        if (ref.kind === 'external') {
            keys.add(externalCompatKey(ref.external_id, ref.loc));
        }
    }

    if (citation.raw_tag) {
        const match = citation.raw_tag.match(/^<citation\b([^>]*)/i);
        if (match) {
            const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
            if (normalized.ok) {
                keys.add(requestedCitationKey(normalized.ref));
                if (normalized.ref.kind === 'external') {
                    keys.add(externalCompatKey(normalized.ref.external_id, normalized.ref.loc));
                }
            }
        }
    }
}

function getCitationMarkerBaseKeys(citation: CitationMetadata): string[] {
    const keys: string[] = [];
    for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
        if (!ref) continue;
        keys.push(baseCitationKey(ref));
        if (ref.kind === 'external') keys.push(externalCompatKey(ref.external_id));
    }
    return [...new Set(keys.filter(Boolean))];
}

function getDisplayRef(citation: CitationMetadata): CitationRef | null {
    return getResolvedRef(citation) ?? getRequestedRef(citation);
}

function getResolvedMetadataFields(citation: CitationMetadata): Partial<CitationMetadata> {
    const ref = getDisplayRef(citation);
    if (!ref) return {};
    if (ref.kind === 'zotero') {
        return {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
        };
    }
    return {
        external_source: ref.source ?? citation.external_source,
        external_source_id: ref.external_id,
    };
}

/**
 * Citation data mapped by full citation key for lookup.
 * 
 * This is the primary lookup mechanism for ZoteroCitation components:
 * - MarkdownRenderer injects data-requested-citation-key during preprocessing
 * - ZoteroCitation looks up metadata using this key
 * - Key includes sid/page for unique identification of citation instances
 * 
 * Key format:
 * - Zotero citations: "zotero:{library_id}-{zotero_key}" or with location: "zotero:1-ABC:sid=s0-s8"
 * - Structured-document locators use the raw token, e.g. "zotero:1-ABC:heading3"
 * - External citations: "external:{external_source_id}" or with location
 * - Invalid citations (fallback): "invalid:{raw_id_value}"
 */
export const citationDataByCitationKeyAtom = atom<Record<string, CitationData>>((get) => {
    const dataMap = get(citationDataMapAtom);
    const byKey: Record<string, CitationData> = {};
    const baseCandidates = new Map<string, CitationData>();
    const ambiguousBaseKeys = new Set<string>();
    
    for (const citation of Object.values(dataMap)) {
        const keys = new Set<string>();
        addCitationKeys(keys, citation);
        for (const key of keys) {
            byKey[key] = citation;
        }

        for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
            if (!ref) continue;
            const baseKeys = ref.kind === 'external'
                ? [baseCitationKey(ref), externalCompatKey(ref.external_id)]
                : [baseCitationKey(ref)];
            for (const baseKey of baseKeys) {
                const existing = baseCandidates.get(baseKey);
                if (existing && existing.citation_id !== citation.citation_id) {
                    ambiguousBaseKeys.add(baseKey);
                } else {
                    baseCandidates.set(baseKey, citation);
                }
            }
        }
        
        if (citation.invalid && citation.raw_tag) {
            const fallbackKey = getInvalidCitationFallbackKey(citation.raw_tag);
            if (fallbackKey) {
                byKey[fallbackKey] = citation;
            }
        }
    }

    for (const [baseKey, citation] of baseCandidates) {
        if (!ambiguousBaseKeys.has(baseKey) && !byKey[baseKey]) {
            byKey[baseKey] = citation;
        }
    }
    
    return byKey;
});

/**
 * Get all citation data as an array (for components that need the full list)
 */
export const citationDataListAtom = atom(
    (get) => Object.values(get(citationDataMapAtom))
);

/**
 * One-time citation tip: shown when the first external or page-locator citation
 * is processed. Persistent pref ensures it fires at most once.
 *
 * Suppressed without setting the pref while: (1) FirstRunPage is visible, or
 * (2) the active thread is a first-run thread (any run carries a first-run
 * origin — `first_run_card` or `first_run_followup`). Avoids overlapping the
 * citation popup with the NextStepsPanel / BackToSuggestions panels.
 */
function maybeTriggerCitationTip(get: (...args: any[]) => any, set: (...args: any[]) => any) {
    if (get(isFirstRunVisibleAtom)) return;
    const activeRun = get(activeRunAtom);
    const threadRuns = get(threadRunsAtom);
    const isFirstRunThread =
        isFirstRunOrigin(activeRun?.user_prompt?.origin) ||
        threadRuns.some((r: any) => isFirstRunOrigin(r.user_prompt?.origin));
    if (isFirstRunThread) return;
    if (getPref('onboardingCitationTipShown')) return;
    setPref('onboardingCitationTipShown', true);

    set(addPopupMessageAtom, {
        type: 'citation_tip' as const,
        title: 'Understanding Citations',
        expire: false,
    });
}

/**
 * Tracks the current pending update promise for race condition handling.
 * This replaces the module-level version counter with a cleaner pattern.
 */
const pendingUpdateRef = { current: null as Promise<void> | null };

export const updateCitationDataAtom = atom(
    null,
    async (get, set) => {
        const metadata = get(citationMetadataAtom);
        const prevMap = get(citationDataMapAtom);
        const externalReferenceMap = get(externalReferenceMappingAtom);
        const newCitationDataMap: Record<string, CitationData> = {};
        logger(`updateCitationDataAtom: Computing ${metadata.length} citations`);
        
        // Create a unique reference for this update
        const thisUpdate = {} as Promise<void>;
        pendingUpdateRef.current = thisUpdate;

        // Extend the citation metadata with the attachment citation data
        for (const citation of metadata) {

            const resolvedRef = getResolvedRef(citation);
            const citationKey = resolvedRef ? baseCitationKey(resolvedRef) : '';
            const prevCitation = prevMap[citation.citation_id];

            // Get or assign numeric citation using the shared thread-scoped atom.
            // This ensures markers assigned during streaming are preserved.
            const markerKeys = getCitationMarkerBaseKeys(citation);
            const numericCitation = set(aliasCitationMarkerKeysAtom, markerKeys) || null;

            // Use existing extended metadata if available
            if (prevCitation) {
                newCitationDataMap[citation.citation_id] = {
                    ...prevCitation,
                    ...citation,
                    ...getResolvedMetadataFields(citation),
                };
                continue;
            }

            logger(`updateCitationDataAtom: Computing citation ${citation.author_year} (${citation.citation_id})`);

            // Handle invalid citations - create minimal entry without Zotero lookup
            if (citation.invalid) {
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    ...getResolvedMetadataFields(citation),
                    type: "item",
                    parentKey: null,
                    icon: null,
                    name: citation.author_year || null,
                    citation: citation.author_year || null,
                    formatted_citation: null,
                    url: null,
                    numericCitation
                };
                continue;
            }

            // Handle external citations differently
            if (isExternalCitation(citation)) {
                maybeTriggerCitationTip(get, set);

                const externalRefForDisplay = getDisplayRef(citation);
                const externalSourceId = externalRefForDisplay?.kind === 'external'
                    ? externalRefForDisplay.external_id
                    : citation.external_source_id;

                // Look up additional data from external reference mapping
                const externalRef = externalSourceId
                    ? externalReferenceMap[externalSourceId]
                    : undefined;

                // Preview for external references
                const externalFormattedCitation = externalRef ? formatExternalCitation(externalRef) : undefined;

                // For external citations, use the metadata directly
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    ...getResolvedMetadataFields(citation),
                    type: "external",
                    parentKey: null,
                    icon: 'webpage-gray',  // Default icon for external references
                    name: citation.author_year || null,
                    citation: citation.author_year || null,
                    formatted_citation: externalFormattedCitation || null,
                    preview: citation.preview,
                    url: null,
                    numericCitation
                };
                continue;
            }

            // Compute new extended metadata for Zotero citations
            try {
                if (!resolvedRef || resolvedRef.kind !== 'zotero') {
                    throw new Error(`Missing library_id or zotero_key for citation ${citation.citation_id}`);
                }

                // Trigger citation tip for Zotero citations with page locators (green)
                if (getCitationPages(citation).length > 0) {
                    maybeTriggerCitationTip(get, set);
                }

                const item = await Zotero.Items.getByLibraryAndKeyAsync(resolvedRef.library_id, resolvedRef.zotero_key);
                if (!item) throw new Error(`Item not found for citation ${citation.citation_id}`);
                await loadFullItemDataWithAllTypes([item]);

                const isAnnotationItem = item.isAnnotation();
                const parentItem = item.parentItem;
                // Annotations live two levels deep: regular item -> attachment ->
                // annotation. Use the grandparent regular item for the
                // bibliographic citation so an annotation citation shares its
                // marker with sibling citations of the same paper.
                const grandparentItem = isAnnotationItem ? parentItem?.parentItem ?? null : null;
                const itemToCite = item.isNote()
                    ? item
                    : isAnnotationItem
                        ? grandparentItem || parentItem || item
                        : parentItem || item;

                const baseDisplayName = getDisplayNameFromItem(itemToCite, null, 30);
                let displayName = getDisplayNameFromItem(itemToCite);
                if (item.isNote()) {
                    displayName = `Note: ${baseDisplayName}`;
                } else if (isAnnotationItem) {
                    displayName = `Annotation: ${baseDisplayName}`;
                }

                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    library_id: resolvedRef.library_id,
                    zotero_key: resolvedRef.zotero_key,
                    type: item.isRegularItem()
                        ? "item"
                        : item.isAttachment()
                            ? "attachment"
                            : item.isNote()
                                ? "note"
                                : isAnnotationItem
                                    ? "annotation"
                                    : "external",
                    parentKey: parentItem?.key || null,
                    icon: item.getItemTypeIconName(),
                    name: displayName,
                    citation: displayName,
                    formatted_citation: getReferenceFromItem(itemToCite),
                    url: createZoteroURI(item),
                    numericCitation
                };
            } catch (error) {
                logger(`updateCitationDataAtom: Error processing citation ${citation.citation_id}: ${error instanceof Error ? error.message : String(error)}`);
                newCitationDataMap[citation.citation_id] = {
                    ...citation,
                    ...getResolvedMetadataFields(citation),
                    type: "item",
                    parentKey: null,
                    icon: null,
                    name: citation.author_year || null,
                    citation: citation.author_year || null,
                    formatted_citation: null,
                    url: null,
                    numericCitation
                };
            }
        }

        // Check if this update is still the most recent one
        // If a newer update started, skip applying this stale result
        if (pendingUpdateRef.current !== thisUpdate) {
            logger(`updateCitationDataAtom: Skipping stale update`, 3);
            return;
        }

        logger(`updateCitationDataAtom: Setting citationDataMapAtom with ${Object.keys(newCitationDataMap).length} citations`);
        set(citationDataMapAtom, newCitationDataMap);
    }
);
