import React from 'react';
import Tooltip from '../primitives/Tooltip';
import { useAtomValue } from 'jotai';
import {
    getCitationBoundingBoxes,
    getContentKind,
    getSymbolicLocation,
    type Citation as CitationMetadata,
} from '@beaver/agent-core/types/citations';
import {
    externalReferenceMappingAtom,
    formatExternalReferenceLabel,
    getExternalReferenceUrl,
} from '@beaver/agent-core/citations/externalReferences';
import { pageLabelsByAttachmentIdAtom, externalFileLocalPathsAtom } from '@beaver/agent-core/citations/atoms';
import { useCitationMarker } from './useCitationMarker';
import { getHost } from '../host';
import type { CitationExportRender } from '../host/types';
import { useCitationViewModel, type CitationViewModel } from './useCitationViewModel';
import { hasAlternateModifier, useAlternateActivation } from './useAlternateActivation';
import { Icon, LibraryIcon, PdfIcon, FileIcon, GlobalSearchIcon, NoteIcon, HighlighterIcon, TextAlignLeftIcon, ExternalLinkIcon } from '../icons';
const TOOLTIP_WIDTH = '250px';

/**
 * Presentational citation component. Client-agnostic: it renders from the
 * citation view model and delegates every client-specific concern (navigation,
 * note export, display config) to the host registry (`../host`). It must not
 * touch the `Zotero` global or import a client's host implementation — the lint
 * guard in `eslint.config.mjs` and the `typecheck:ui` closure gate enforce this.
 *
 * Supported citation tag formats from LLM:
 *   <citation id="libraryID-itemKey"/>           - library item reference
 *   <citation id="..." loc="page5"/>             - library item with page reference
 *   <citation id="..." loc="s25"/>               - library item with sentence/record ID
 *   <citation external_id="..."/>                - external reference
 * Legacy item_id/att_id/page attrs are still accepted by preprocessing.
 *
 * Note: Props are passed from HTML attributes after sanitization,
 * so values may have 'user-content-' prefix added by rehype-sanitize.
 */
interface CitationProps {
    dataLibraryId?: string | number;
    dataLibraryRef?: string;
    dataZoteroKey?: string;
    dataExternalId?: string;
    dataExternalSource?: string;
    dataExtKey?: string;
    dataLoc?: string;
    dataLocKind?: string;
    dataLocValue?: string;
    dataRequestedCitationKey?: string;
    dataResolvedCitationKey?: string;
    dataConsecutive?: boolean | string;
    dataAdjacent?: boolean | string;
    dataInvalidReason?: string;
    dataRawIdentity?: string;
    dataIdentityAttr?: string;
    [key: string]: unknown;
    // Rendering options
    exportRendering?: boolean;
    children?: React.ReactNode;
    /**
     * An assembled citation, rendered without a tag or the thread's store, and
     * the numeric marker its caller numbered it with.
     */
    citation?: CitationMetadata;
    marker?: string;
}

/**
 * Wrap a host-rendered export citation: raw HTML, or a native citation span
 * carrying its serialized payload. Both hold HTML, e.g.
 * "(<span class="citation-item">Author, 2024</span>)".
 */
function renderExportedCitation(exported: CitationExportRender): React.ReactElement {
    if (exported.kind === 'html') {
        return <span dangerouslySetInnerHTML={{ __html: exported.html }} />;
    }
    return (
        <span
            className="citation"
            data-citation={exported.citationData}
            dangerouslySetInnerHTML={{ __html: exported.html }}
        />
    );
}

/**
 * What a citation is and where its click leads, derived from its view model.
 * Shared by the citation marker and by callers that draw their own anchor for
 * an assembled citation (a table's page tags), so both navigate alike.
 */
export interface CitationTargetFlags {
    isNoteCitation: boolean;
    isAnnotationCitation: boolean;
    isEpubCitation: boolean;
    hasEpubSymbolicLocator: boolean;
    isTextCitation: boolean;
    isSnapshotCitation: boolean;
    hasSnapshotSymbolicLocator: boolean;
    hasBoundingBoxes: boolean;
    /** A PDF or EPUB page-or-box locator: the click lands inside the document. */
    hasLocator: boolean;
    /** Whether alternate activation (reveal the cited work) changes anything. */
    canRevealItem: boolean;
}

export function citationTargetFlags(vm: CitationViewModel): CitationTargetFlags {
    const metadata = vm.metadata;
    const isNoteCitation = metadata?.citation_type === 'note';
    const isAnnotationCitation = metadata?.citation_type === 'annotation';
    const contentKind = getContentKind(metadata);
    const symbolic = getSymbolicLocation(metadata);
    const isEpubCitation = contentKind === 'epub';
    const hasEpubSymbolicLocator = isEpubCitation && symbolic?.content_kind === 'epub';
    const isTextCitation = contentKind === 'text';
    const isSnapshotCitation = contentKind === 'snapshot';
    // Snapshots resolve a cited passage from the symbolic anchor/text, not pages
    // (the reader is a continuous scroll view); any synthetic page on the wire is
    // a coarse navigation hint only and is never shown.
    const hasSnapshotSymbolicLocator = isSnapshotCitation && symbolic?.content_kind === 'snapshot';
    const hasBoundingBoxes = !isNoteCitation && !isAnnotationCitation && !!metadata && getCitationBoundingBoxes(metadata).length > 0;
    // PDF/EPUB page-or-box locator. Snapshots are excluded here: they carry a
    // synthetic page that must not be presented as a PDF page locator.
    const hasLocator = !isNoteCitation && !isAnnotationCitation && !isSnapshotCitation
        && (vm.pages.length > 0 || hasBoundingBoxes || hasEpubSymbolicLocator);
    // Alternate activation acts on the cited work rather than the cited passage.
    // It stays inert wherever it would change nothing: an unmapped external
    // reference and an external file have no library item behind them; a
    // streaming or invalid citation has no click at all; and a plain
    // locator-less item is already revealed in the library by an ordinary
    // click. What is left is exactly the set whose click it redirects.
    const defaultRevealsItem = !hasLocator
        && !isSnapshotCitation
        && !isTextCitation
        && !isNoteCitation
        && !isAnnotationCitation;
    const canRevealItem = !vm.isExternalFile
        && (!vm.isExternal || !!vm.mappedZoteroItem)
        && !!vm.effectiveItemKey
        && !vm.isStreaming
        && !vm.isInvalid
        && !defaultRevealsItem;
    return {
        isNoteCitation,
        isAnnotationCitation,
        isEpubCitation,
        hasEpubSymbolicLocator,
        isTextCitation,
        isSnapshotCitation,
        hasSnapshotSymbolicLocator,
        hasBoundingBoxes,
        hasLocator,
        canRevealItem,
    };
}

/**
 * Hand a ready citation to the host's activation: the cited passage, or the
 * cited work when `alternate` asks for it and that changes anything.
 */
function activateCitationViewModel(
    vm: CitationViewModel,
    flags: CitationTargetFlags,
    ownerDocument: Document,
    alternate: boolean,
): void {
    if (!vm.metadata || vm.isStreaming || vm.isInvalid) return;
    void getHost().navigation?.activateCitation({
        metadata: vm.metadata,
        intent: flags.canRevealItem && alternate ? 'item' : 'passage',
        isExternal: vm.isExternal,
        isExternalFile: vm.isExternalFile,
        externalFileKey: vm.externalFileKey,
        externalSourceId: vm.externalSourceId,
        hasMappedItem: !!vm.mappedZoteroItem,
        effectiveLibraryID: vm.effectiveLibraryID,
        effectiveItemKey: vm.effectiveItemKey,
        effectiveLibraryRef: vm.effectiveLibraryRef,
        previewText: vm.previewText,
        ownerDocument,
    });
}

/** An assembled citation's view model and its activation, for a caller-drawn anchor. */
export interface CitationActivationHandle {
    vm: CitationViewModel;
    flags: CitationTargetFlags;
    /** Whether the citation can be activated at all (ready, not invalid). */
    ready: boolean;
    /**
     * Activate as the citation marker's own click does. Pass the click so the
     * alternate-activation modifier is honoured; anything with an
     * `ownerDocument` (an element) activates the passage.
     */
    activate(source: React.MouseEvent | { ownerDocument: Document }): void;
}

/**
 * The click of the chat's `Citation` for an assembled citation whose anchor
 * the caller draws itself: the same view model and the same host activation,
 * so a table's page tag opens the passage exactly as a marker would.
 */
export function useCitationActivation(citation: CitationMetadata): CitationActivationHandle {
    const props = React.useMemo(() => ({ citation }), [citation]);
    const vm = useCitationViewModel(props);
    const flags = citationTargetFlags(vm);
    const ready = !!vm.metadata && !vm.isStreaming && !vm.isInvalid;
    const activate = (source: React.MouseEvent | { ownerDocument: Document }) => {
        if ('currentTarget' in source) {
            source.preventDefault();
            const target = source.currentTarget as Element;
            const doc = target.ownerDocument;
            activateCitationViewModel(vm, flags, doc, hasAlternateModifier(source, doc.defaultView?.navigator));
            return;
        }
        activateCitationViewModel(vm, flags, source.ownerDocument, false);
    };
    return { vm, flags, ready, activate };
}

const Citation: React.FC<CitationProps> = (props) => {
    const { exportRendering = false } = props;

    // Derive the render-ready view model. This is client-agnostic: it reads only
    // self-contained citation metadata (citation v2) and shared atoms, with the
    // one host-specific concern (legacy page-label fallback) delegated to the
    // citation host. Zotero data access below is confined to the click/export
    // paths, which are inherently host-specific.
    const vm = useCitationViewModel(props as Record<string, unknown>);
    const {
        metadata: citationMetadata,
        isExternal,
        isExternalFile,
        externalFileKey,
        markerKey,
        displayState,
        isStreaming,
        isInvalid,
        libraryID,
        itemKey,
        requestedRef,
        externalSourceId,
        mappedZoteroItem,
        effectiveLibraryID,
        effectiveItemKey,
        effectiveLibraryRef,
        consecutive,
        citation,
        formatted_citation,
        previewText,
        locatorDisplay,
        pageReference,
        pages,
    } = vm;

    // External-reference map is read for the (presentational) external-citation
    // export branch below.
    const externalReferenceMap = useAtomValue(externalReferenceMappingAtom);
    // Read via the active store (the Provider's, isolated during note export) so
    // export locators use the labels renderToHTML preloads.
    const labelsByAttachmentId = useAtomValue(pageLabelsByAttachmentIdAtom);
    // Host-resolved local paths for external files (note export only); empty
    // otherwise. Read from the active store so it respects the isolated export store.
    const externalFileLocalPaths = useAtomValue(externalFileLocalPathsAtom);

    // Get the citation format preference
    const authorYearFormat = (getHost().config?.citationFormat() ?? 'author-year') !== 'numeric';

    // Get or assign numeric marker using base key (same item = same marker)
    // Uses markerKey (without sid/page) so all citations to the same item share a marker
    // A direct citation belongs to its caller (a table's evidence), which numbers
    // it; it never takes a number from the thread's marker map.
    const direct = props.citation !== undefined;
    const numericMarker = useCitationMarker(direct ? '' : markerKey, exportRendering);

    // Whether the alternate-activation modifier is being held. Document-wide, so
    // every citation flips together and the hold reads as a mode.
    const { isAlternate, ref: citationRef } = useAlternateActivation();

    // Render as soon as we have an identifier; citationMetadata may arrive later.
    // 'error' state means no valid identifier was found - don't render.
    if (displayState === 'error') return null;

    // Format for display
    let displayText = '';
    const hasLocatorDisplay = locatorDisplay.length > 0;
    if (authorYearFormat) {
        if (isStreaming || isInvalid) {
            // We don't know the author/year string yet, or citation is invalid. Render a subtle placeholder.
            displayText = '?';
        } else {
            displayText = consecutive
                ? (hasLocatorDisplay ? locatorDisplay : 'Ibid')
                : (hasLocatorDisplay ? `${citation}, ${locatorDisplay}` : citation);
        }
    } else {
        // Numeric markers should be stable and independent of citationMetadata.
        // If key is missing (invalid/malformed citation) or invalid, show placeholder.
        displayText = (markerKey && !isInvalid) ? (direct ? props.marker ?? '?' : numericMarker) : '?';
    }

    // Rendering for export to Zotero note (using CSL JSON for citations)
    if (exportRendering) {
        displayText = authorYearFormat ? ` (${displayText})` : ` [${displayText}]`;

        // External works not in the library: a host-native citation when the
        // host can build one, otherwise a link to the work.
        if (isExternal && !mappedZoteroItem) {
            const externalReference = externalSourceId
                ? externalReferenceMap[externalSourceId]
                : undefined;
            const exportedReference = externalSourceId && externalReference
                ? getHost().documentExport?.renderExternalReferenceCitation?.({
                    externalId: externalSourceId,
                    reference: externalReference,
                    requestedRef,
                })
                : null;
            if (exportedReference) return renderExportedCitation(exportedReference);
            const label = citation
                || (externalReference ? formatExternalReferenceLabel(externalReference) : '')
                || externalSourceId
                || 'External reference';
            const url = externalReference
                ? getExternalReferenceUrl(externalReference)
                : undefined;
            if (url) {
                return (
                    <span>
                        (
                        <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
                        )
                    </span>
                );
            }
            return (<span>{`(${label})`}</span>);
        }

        // External-file citations have no Zotero item to format and are excluded
        // from the bibliography. Preserve the cited page/section locator so the
        // export is as specific as the chat view. The host may upgrade this to a
        // clickable link to the locally stored file; the plain-text form is the
        // client-agnostic fallback when the host can't (e.g. no local copy).
        if (isExternalFile) {
            // A file this device has never seen carries neither metadata nor a
            // local copy. Name it by its id rather than export an empty pair of
            // parentheses.
            const fileLabel = citation || (externalFileKey ? `Attached file ext-${externalFileKey}` : '');
            const locatorSuffix = hasLocatorDisplay ? `, ${locatorDisplay}` : '';
            const exportedFile = getHost().documentExport?.renderExternalFileCitation?.({
                externalFileKey,
                displayName: fileLabel,
                locatorSuffix,
                localPathsByExtKey: externalFileLocalPaths,
            });
            if (exportedFile && exportedFile.kind === 'html') {
                return <span dangerouslySetInnerHTML={{ __html: exportedFile.html }} />;
            }
            return (<span>{`(${fileLabel}${locatorSuffix})`}</span>);
        }

        // For library citations, delegate host-native formatting (CSL for
        // Zotero) to the host. The host returns formatted HTML; the wrapping
        // element shape stays here so this component owns all the JSX.
        const exported = getHost().documentExport?.renderCitation({
            effectiveLibraryID,
            effectiveItemKey,
            effectiveLibraryRef,
            requestedRef,
            pages,
            metadata: citationMetadata,
            pageLabelsByAttachmentId: labelsByAttachmentId,
        });
        return exported ? renderExportedCitation(exported) : null;
    }

    // Determine the CSS class based on citation type and state
    const flags = citationTargetFlags(vm);
    const {
        isNoteCitation,
        isAnnotationCitation,
        isEpubCitation,
        isTextCitation,
        isSnapshotCitation,
        hasSnapshotSymbolicLocator,
        hasBoundingBoxes,
        hasLocator,
        canRevealItem,
    } = flags;
    const symbolicLocationForDisplay = getSymbolicLocation(citationMetadata);
    const textLineLocation = isTextCitation && symbolicLocationForDisplay?.content_kind === 'text'
        ? symbolicLocationForDisplay
        : undefined;
    const showItemInfo = isAlternate && canRevealItem;

    // Click handler — delegates all client-specific navigation to the host.
    // The streaming/invalid states don't attach this handler (see below), so it
    // only runs for "ready" citations where metadata is present.
    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        // Read the modifier off the click rather than the hover state, so the
        // action always matches the key that was actually held down.
        activateCitationViewModel(
            vm,
            flags,
            e.currentTarget.ownerDocument,
            hasAlternateModifier(e, e.currentTarget.ownerDocument.defaultView?.navigator),
        );
    };

    // The locator style promises navigation to a place inside the document.
    // While the modifier is held the click reveals the work instead, so the
    // marker drops to the plain style — which is already exactly how a citation
    // whose click reveals its item is drawn.
    const citationClassBase = isExternal && !mappedZoteroItem
        ? "zotero-citation external-citation"
        : (hasLocator || isAnnotationCitation || hasSnapshotSymbolicLocator) && !isExternalFile && !showItemInfo
        ? "zotero-citation with-locator"
        : "zotero-citation";
    const citationClass = isStreaming
        ? `${citationClassBase} streaming`
        : isInvalid
        ? `${citationClassBase} invalid`
        : citationClassBase;
    const showPreviewText = previewText && previewText !== citation;
    // Body of the alternate ("item") hover state: the full bibliographic
    // reference. Suppressed when it would only repeat the header.
    const itemInfoText = formatted_citation && formatted_citation !== citation
        ? formatted_citation
        : '';

    const citationElement = (
        <span 
            ref={citationRef}
            onClick={(isStreaming || isInvalid) ? undefined : handleClick}
            className={citationClass}
            data-pages={pages}
            data-item-key={itemKey}
            data-library-id={libraryID}
        >
            {displayText}
        </span>
    );

    const citationPreview = (
        <span className="block" style={{ overflow: 'hidden' }}>
            <span className="px-3 py-15 display-flex flex-row border-bottom-quinary gap-2">
                <span className="font-color-primary text-sm" style={{ minWidth: 0, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    {citation}
                </span>
                <span className="flex-1" />
                {!showItemInfo && hasLocatorDisplay && (
                    <span className="font-color-secondary text-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {pageReference.charAt(0).toUpperCase() + pageReference.slice(1)}
                    </span>
                )}
                {!showItemInfo && (!pages || pages.length === 0) && textLineLocation && (
                    <span className="font-color-secondary text-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {textLineLocation.line_end && textLineLocation.line_end !== textLineLocation.line
                            ? `Lines ${textLineLocation.line}–${textLineLocation.line_end}`
                            : `Line ${textLineLocation.line}`}
                    </span>
                )}
            </span>
            {showItemInfo ? (
                <>
                    {itemInfoText && (
                        <span className="font-color-secondary text-sm px-3 py-15 block" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                            {itemInfoText}
                        </span>
                    )}
                    <span className={`px-3 py-15 block ${itemInfoText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={LibraryIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                Reveals item in library
                            </span>
                        </span>
                    </span>
                </>
            ) : (
                <>
                {showPreviewText && (
                    <span className="font-color-secondary text-sm px-3 py-15 block" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                        {previewText}
                    </span>
                )}
                {isExternal && !mappedZoteroItem && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={GlobalSearchIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                View details
                            </span>
                        </span>
                    </span>
                )}
                {isExternalFile && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={ExternalLinkIcon} className="font-color-secondary scale-90" />
                            <span className="text-sm font-color-secondary">
                                Opens external file
                            </span>
                        </span>
                    </span>
                )}
                {isNoteCitation && !isExternalFile && (!isExternal || !!mappedZoteroItem) && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={NoteIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                Opens note
                            </span>
                        </span>
                    </span>
                )}
                {isAnnotationCitation && !isExternalFile && (!isExternal || !!mappedZoteroItem) && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={HighlighterIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                Opens annotation in PDF
                            </span>
                        </span>
                    </span>
                )}
                {hasLocator && !isExternalFile && (!isExternal || !!mappedZoteroItem) && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={PdfIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                {isEpubCitation
                                    ? (hasLocatorDisplay ? `Opens EPUB at ${pageReference}` : 'Opens EPUB at location')
                                    : hasBoundingBoxes
                                        ? (hasLocatorDisplay ? `Highlights passage on ${pageReference}` : 'Highlights passage in PDF')
                                        : (hasLocatorDisplay ? `Opens PDF on ${pageReference}` : 'Opens PDF at location')}
                            </span>
                        </span>
                    </span>
                )}
                {isTextCitation && !isExternalFile && !isNoteCitation && !isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={TextAlignLeftIcon} className="font-color-secondary scale-90" />
                            <span className="text-sm font-color-secondary">
                                Opens text file (external application)
                            </span>
                        </span>
                    </span>
                )}
                {isSnapshotCitation && !isExternalFile && !isNoteCitation && !isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={FileIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                {hasSnapshotSymbolicLocator ? 'Opens Snapshot at location' : 'Opens Snapshot'}
                            </span>
                        </span>
                    </span>
                )}
                {!hasLocator && !isSnapshotCitation && !isExternalFile && !isTextCitation && !isNoteCitation && !isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                    <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                        <span className="display-flex flex-row items-center gap-15">
                            <Icon icon={LibraryIcon} className="font-color-secondary" />
                            <span className="text-sm font-color-secondary">
                                Reveals item in library
                            </span>
                        </span>
                    </span>
                )}
                </>
            )}
        </span>
    )

    // Return the citation with tooltip and click handler
    // - Streaming state: no tooltip (metadata not available yet)
    // - Invalid state: simple error tooltip
    // - Ready state: show tooltip with preview
    return (
        <>
            {exportRendering ?
                citationElement
            :
                isStreaming ?
                    citationElement
                :
                isInvalid ?
                    <Tooltip
                        content="Invalid citation"
                        width="104px"
                        singleLine
                    >
                        {citationElement}
                    </Tooltip>
                :
                    <Tooltip
                        content={previewText}
                        customContent={citationPreview}
                        contentKey={showItemInfo ? 'item' : 'passage'}
                        width={TOOLTIP_WIDTH}
                        padding={false}
                    >
                        {citationElement}
                    </Tooltip>
            }
        </>
    );

};

export default Citation;
