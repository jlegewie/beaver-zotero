import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { citationByKeyAtom, pageLabelsByAttachmentIdAtom } from '../../atoms/citations';
import { externalReferenceItemMappingAtom } from '../../atoms/externalReferences';
import {
    Citation,
    getCitationPages,
    isExternalCitation,
    isExternalFileCitation,
} from '../../types/citations';
import {
    baseCitationKey,
    CitationRef,
    getResolvedRef,
    LocatorKind,
    requestedCitationKey,
} from '../../utils/citationGrammar';
import { formatNumberRanges, formatPageRangesWithLabels } from '../../utils/stringUtils';
import { resolvePageLabelFromLabels } from '../../utils/pageLabels';
import { ZoteroItemReference } from '../../types/zotero';
import { getPref } from '../../../src/utils/prefs';
import { getHost } from '../../host';

/**
 * Citation display state - explicit FSM for citation lifecycle.
 *
 * States:
 * - 'streaming': Tag parsed, waiting for metadata (shows "?")
 * - 'ready': Metadata available, fully rendered
 * - 'invalid': Citation could not be resolved (shows "?" with error tooltip)
 * - 'error': No identifier found (renderer returns null)
 */
export type CitationDisplayState = 'streaming' | 'ready' | 'invalid' | 'error';

/**
 * Parsed identity model for a citation tag, before metadata lookup.
 */
type CitationPropsModel =
    | { ok: true; ref: CitationRef; requestedKey: string; consecutive: boolean; adjacent: boolean }
    | { ok: false; requestedKey: string; rawIdentity?: string; reason?: string; consecutive: boolean; adjacent: boolean };

function propValue(props: Record<string, unknown>, camel: string, kebab: string): string | undefined {
    const value = props[camel] ?? props[kebab];
    if (value == null || value === false) return undefined;
    return String(value);
}

function propBool(props: Record<string, unknown>, camel: string, kebab: string): boolean {
    const value = props[camel] ?? props[kebab];
    return value === true || value === 'true';
}

/**
 * Parse raw citation tag props (HTML data attributes, possibly with a
 * 'user-content-' prefix added by rehype-sanitize) into a citation reference.
 *
 * Supported citation tag formats from LLM:
 *   <citation id="libraryID-itemKey"/>           - Zotero item reference
 *   <citation id="..." loc="page5"/>             - Zotero item with page reference
 *   <citation id="..." loc="s25"/>               - Zotero item with sentence/record ID
 *   <citation external_id="..."/>                - external reference
 * Legacy item_id/att_id/page attrs are still accepted by preprocessing.
 */
export function readCitationProps(props: Record<string, unknown>): CitationPropsModel {
    const consecutive = propBool(props, 'dataConsecutive', 'data-consecutive');
    const adjacent = propBool(props, 'dataAdjacent', 'data-adjacent');
    const requestedKey = propValue(props, 'dataRequestedCitationKey', 'data-requested-citation-key') || '';
    const rawIdentity = propValue(props, 'dataRawIdentity', 'data-raw-identity');
    const invalidReason = propValue(props, 'dataInvalidReason', 'data-invalid-reason');
    if (invalidReason) {
        return { ok: false, requestedKey, rawIdentity, reason: invalidReason, consecutive, adjacent };
    }

    const libraryIDRaw = propValue(props, 'dataLibraryId', 'data-library-id');
    const zoteroKey = propValue(props, 'dataZoteroKey', 'data-zotero-key');
    const externalId = propValue(props, 'dataExternalId', 'data-external-id');
    const externalSource = propValue(props, 'dataExternalSource', 'data-external-source');
    const extKey = propValue(props, 'dataExtKey', 'data-ext-key');
    const locRaw = propValue(props, 'dataLoc', 'data-loc');
    const locKind = propValue(props, 'dataLocKind', 'data-loc-kind');
    const locValue = propValue(props, 'dataLocValue', 'data-loc-value');
    const loc = locRaw
        ? { kind: (locKind || 'unknown') as LocatorKind, value: locValue || locRaw, raw: locRaw }
        : undefined;

    if (libraryIDRaw && zoteroKey) {
        const libraryID = Number(libraryIDRaw);
        if (Number.isInteger(libraryID) && libraryID > 0) {
            const ref: CitationRef = { kind: 'zotero', library_id: libraryID, zotero_key: zoteroKey, ...(loc ? { loc } : {}) };
            return { ok: true, ref, requestedKey: requestedKey || requestedCitationKey(ref), consecutive, adjacent };
        }
    }
    if (extKey) {
        const ref: CitationRef = {
            kind: 'external_file',
            ext_key: extKey.toUpperCase(),
            ...(loc ? { loc } : {}),
        };
        return { ok: true, ref, requestedKey: requestedKey || requestedCitationKey(ref), consecutive, adjacent };
    }
    if (externalId) {
        const ref: CitationRef = {
            kind: 'external',
            external_id: externalId,
            ...(externalSource ? { source: externalSource } : {}),
            ...(loc ? { loc } : {}),
        };
        return { ok: true, ref, requestedKey: requestedKey || requestedCitationKey(ref), consecutive, adjacent };
    }

    return { ok: false, requestedKey, rawIdentity, reason: invalidReason || 'missing_identity', consecutive, adjacent };
}

/**
 * View model for a single rendered citation.
 *
 * Derived purely from self-contained citation metadata (citation v2) plus
 * client-agnostic Jotai state. No Zotero item/data access happens here; the one
 * host-specific concern (legacy page-label fallback) is delegated to the active
 * citation host. This keeps the derivation portable across clients.
 */
export interface CitationViewModel {
    /** Resolved citation metadata, or undefined while streaming. */
    metadata?: Citation;
    /** Identity as cited by the model (null when unparseable). */
    requestedRef: CitationRef | null;
    /** Canonical resolved identity (null until/unless resolved). */
    resolvedRef: CitationRef | null;
    /** Full key for metadata lookup (includes loc/page). */
    citationKey: string;
    /** Base key for numeric marker assignment (item-only). */
    markerKey: string;
    displayState: CitationDisplayState;
    isStreaming: boolean;
    isInvalid: boolean;
    isExternal: boolean;
    isExternalFile: boolean;
    externalFileKey: string | null;
    externalSourceId?: string;
    /** Resolved Zotero identity (0 / '' when not a Zotero citation). */
    libraryID: number;
    itemKey: string;
    /** Zotero item an external reference maps to, when imported. */
    mappedZoteroItem?: ZoteroItemReference | null;
    /** Effective identity, accounting for mapped external references. */
    effectiveLibraryID: number;
    effectiveItemKey: string;
    consecutive: boolean;
    adjacent: boolean;
    /** Display strings derived from metadata. */
    formatted_citation: string;
    citation: string;
    previewText: string;
    /** Page labels for display (raw page numbers when labels unavailable). */
    pageLabels: string[];
    pagesDisplay: string;
    pages: number[];
}

/**
 * Derive the render-ready view model for a citation from its tag props.
 *
 * Pure derivation over citation metadata and client-agnostic atoms. The only
 * host-specific dependency is the optional page-label fallback, delegated to
 * the citation host.
 *
 * Note: display config (`citationFormat`, `usePageLabels`) is read from host
 * prefs for now. A future change can inject this so the hook is fully
 * host-agnostic.
 */
export function useCitationViewModel(props: Record<string, unknown>): CitationViewModel {
    const parsedProps = useMemo(() => readCitationProps(props), [props]);

    const citationDataByCitationKey = useAtomValue(citationByKeyAtom);
    const externalReferenceToZoteroItem = useAtomValue(externalReferenceItemMappingAtom);
    const labelsByAttachmentId = useAtomValue(pageLabelsByAttachmentIdAtom);

    // Whether page locators should render using the PDF's page labels (e.g.,
    // Roman numerals for front matter) instead of raw page numbers.
    const usePageLabels = getPref('usePageLabels') !== false;

    // =========================================================================
    // IDENTITY RESOLUTION - Using normalized citation keys for lookup and markers
    // =========================================================================
    //
    // data-requested-citation-key is injected by preprocessCitations for metadata
    // lookup. It includes sid/page for unique identification of citation instances.
    //
    // For marker assignment, we use a base key (item-only) so that all citations
    // to the same item get the same marker number.
    const identity = useMemo(() => {
        const citationKey = parsedProps.requestedKey || '';

        let metadata = citationKey
            ? citationDataByCitationKey[citationKey]
            : undefined;

        if (!metadata && parsedProps.ok) {
            metadata = citationDataByCitationKey[baseCitationKey(parsedProps.ref)];
        }

        if (!metadata) {
            const rawIdentity = parsedProps.ok ? undefined : parsedProps.rawIdentity;
            if (rawIdentity) {
                metadata = citationDataByCitationKey[`invalid:${rawIdentity}`];
            }
        }

        let markerKey = parsedProps.ok ? baseCitationKey(parsedProps.ref) : '';
        const resolvedRef = metadata ? getResolvedRef(metadata) : null;
        if (resolvedRef) {
            markerKey = baseCitationKey(resolvedRef);
        }

        const displayRef = resolvedRef ?? (parsedProps.ok ? parsedProps.ref : null);
        const zoteroRef = displayRef?.kind === 'zotero'
            ? { libraryID: displayRef.library_id, itemKey: displayRef.zotero_key }
            : null;
        const externalSourceId = displayRef?.kind === 'external'
            ? displayRef.external_id
            : undefined;

        // Determine citation type
        const isExternal = metadata
            ? isExternalCitation(metadata)
            : displayRef?.kind === 'external' || citationKey.startsWith('external:');
        const isExternalFile = metadata
            ? isExternalFileCitation(metadata)
            : displayRef?.kind === 'external_file' || citationKey.startsWith('extfile:');
        const externalFileKey = displayRef?.kind === 'external_file'
            ? displayRef.ext_key
            : null;

        // Determine display state (FSM)
        const hasIdentifier = parsedProps.ok || !!citationKey || (!parsedProps.ok && !!parsedProps.rawIdentity);
        let displayState: CitationDisplayState;
        if (!hasIdentifier) {
            displayState = 'error';
        } else if (!metadata) {
            displayState = 'streaming';
        } else if (metadata.invalid) {
            displayState = 'invalid';
        } else {
            displayState = 'ready';
        }

        return {
            metadata,
            isExternal,
            isExternalFile,
            externalFileKey,
            citationKey,     // Full key for metadata lookup
            markerKey,       // Base key for marker assignment
            displayState,
            // Convenience accessors
            libraryID: zoteroRef?.libraryID ?? 0,
            itemKey: zoteroRef?.itemKey ?? '',
            requestedRef: parsedProps.ok ? parsedProps.ref : null,
            resolvedRef,
            externalSourceId,
        };
    }, [parsedProps, citationDataByCitationKey]);

    const {
        metadata,
        isExternal,
        isExternalFile,
        externalFileKey,
        citationKey,
        markerKey,
        displayState,
        libraryID,
        itemKey,
        requestedRef,
        resolvedRef,
        externalSourceId,
    } = identity;

    // For external citations, check if they map to a Zotero item.
    const mappedZoteroItem = isExternal && externalSourceId
        ? externalReferenceToZoteroItem[externalSourceId]
        : undefined;

    // Compute effective libraryID and itemKey (accounting for mapped external citations).
    const effectiveLibraryID = libraryID || mappedZoteroItem?.library_id || 0;
    const effectiveItemKey = itemKey || mappedZoteroItem?.zotero_key || '';

    // Derive citation display data from metadata alone (citation v2): no Zotero
    // item access happens here, so the same render path works for Zotero items,
    // external references, and external files. When metadata is not available
    // (streaming), values are empty and the renderer shows the inactive state.
    const { formatted_citation, citation, previewText, rawPages } = useMemo(() => {
        if (!metadata) {
            return {
                formatted_citation: '',
                citation: '',
                previewText: '',
                rawPages: [] as number[],
            };
        }

        const citation = metadata.display_name || '';
        let formatted_citation = metadata.formatted_citation || '';
        let previewText = metadata.preview
            ? `"${metadata.preview}"`
            : formatted_citation || (isExternalFile ? citation : '');

        // Strip URLs from formatted citation and preview text (they clutter the tooltip)
        const stripUrls = (s: string) => s.replace(/\s*https?:\/\/\S+/g, '').trim();
        // Convert <br> tags to newlines and strip any remaining HTML tags
        // (note previews arrive as HTML fragments and would otherwise render as literal markup)
        const stripHtml = (s: string) => s
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        formatted_citation = stripHtml(stripUrls(formatted_citation));
        previewText = stripHtml(stripUrls(previewText));

        const pages = [...new Set(getCitationPages(metadata))];

        return {
            formatted_citation,
            citation,
            previewText,
            rawPages: pages,
        };
    }, [metadata, isExternalFile]);

    // Resolve page labels separately so page-label preload updates don't force
    // the citation/preview/HTML-stripping work above to recompute. The legacy
    // fallback (loading labels from the cited Zotero item) is delegated to the
    // citation host; this hook stays free of Zotero data access. We pass the
    // subscribed `labelsByAttachmentId` (from the active store) to the host so
    // it resolves correctly under the isolated store used for note export, and
    // so the recompute fires once the async page-label preload populates it.
    const { pageLabels, pagesDisplay, pages } = useMemo(() => {
        let pageLabels: string[] = rawPages.map((p) => String(p));

        if (usePageLabels && rawPages.length > 0) {
            const backendLabels = metadata?.page_labels;
            if (backendLabels && Object.keys(backendLabels).length > 0) {
                pageLabels = rawPages.map((p) => resolvePageLabelFromLabels(backendLabels, p));
            } else if (resolvedRef) {
                const hostLabels = getHost().itemData?.resolvePageLabels(resolvedRef, labelsByAttachmentId) ?? null;
                if (hostLabels) {
                    pageLabels = rawPages.map((p) => resolvePageLabelFromLabels(hostLabels, p));
                }
            }
        }

        const pagesDisplay = rawPages.length === 0
            ? ''
            : usePageLabels
                ? formatPageRangesWithLabels(rawPages, pageLabels)
                : formatNumberRanges(rawPages);

        return { pageLabels, pagesDisplay, pages: rawPages };
    }, [rawPages, usePageLabels, resolvedRef, labelsByAttachmentId, metadata]);

    return {
        metadata,
        requestedRef,
        resolvedRef,
        citationKey,
        markerKey,
        displayState,
        isStreaming: displayState === 'streaming',
        isInvalid: displayState === 'invalid',
        isExternal,
        isExternalFile,
        externalFileKey,
        externalSourceId,
        libraryID,
        itemKey,
        mappedZoteroItem,
        effectiveLibraryID,
        effectiveItemKey,
        consecutive: parsedProps.consecutive,
        adjacent: parsedProps.adjacent,
        formatted_citation,
        citation,
        previewText,
        pageLabels,
        pagesDisplay,
        pages,
    };
}
