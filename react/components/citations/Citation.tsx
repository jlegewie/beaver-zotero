import React from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue } from 'jotai';
import {
    getCitationBoundingBoxes,
    getContentKind,
    getSymbolicLocation,
} from '../../types/citations';
import { externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { pageLabelsByAttachmentIdAtom, externalFileLocalPathsAtom } from '../../atoms/citations';
import { useCitationMarker } from '../../hooks/useCitationMarker';
import { getHost } from '../../host';
import { useCitationViewModel } from './useCitationViewModel';
import { Icon, LibraryIcon, PdfIcon, FileIcon, GlobalSearchIcon, NoteIcon, HighlighterIcon, TextAlignLeftIcon, ExternalLinkIcon } from '../icons/icons';
const TOOLTIP_WIDTH = '250px';

/**
 * Presentational citation component. Client-agnostic: it renders from the
 * citation view model and delegates every client-specific concern (navigation,
 * note export, display config) to the host registry (`react/host`). It must not
 * touch the `Zotero` global or import the Zotero host implementation — the lint
 * guard in `eslint.config.mjs` enforces this.
 * See docs-zotero/client-host-architecture.md.
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
        previewText,
        pagesDisplay,
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
    const numericMarker = useCitationMarker(markerKey, exportRendering);

    // Render as soon as we have an identifier; citationMetadata may arrive later.
    // 'error' state means no valid identifier was found - don't render.
    if (displayState === 'error') return null;

    // Click handler — delegates all client-specific navigation to the host.
    // The streaming/invalid states don't attach this handler (see below), so it
    // only runs for "ready" citations where metadata is present.
    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        if (!citationMetadata) return;
        getHost().navigation?.activateCitation({
            metadata: citationMetadata,
            isExternal,
            isExternalFile,
            externalFileKey,
            externalSourceId,
            hasMappedItem: !!mappedZoteroItem,
            effectiveLibraryID,
            effectiveItemKey,
            effectiveLibraryRef,
            previewText,
            ownerDocument: e.currentTarget.ownerDocument,
        });
    };

    // Format for display
    let displayText = '';
    const hasLocatorDisplay = pagesDisplay.trim().length > 0;
    if (authorYearFormat) {
        if (isStreaming || isInvalid) {
            // We don't know the author/year string yet, or citation is invalid. Render a subtle placeholder.
            displayText = '?';
        } else {
            displayText = consecutive
                ? (hasLocatorDisplay ? `p.${pagesDisplay}` : 'Ibid')
                : (hasLocatorDisplay ? `${citation}, p.${pagesDisplay}` : citation);
        }
    } else {
        // Numeric markers should be stable and independent of citationMetadata.
        // If key is missing (invalid/malformed citation) or invalid, show placeholder.
        displayText = (markerKey && !isInvalid) ? numericMarker : '?';
    }

    // Rendering for export to Zotero note (using CSL JSON for citations)
    if (exportRendering) {
        displayText = authorYearFormat ? ` (${displayText})` : ` [${displayText}]`;

        // External citations cannot be exported as proper Zotero citations
        if (isExternal && !mappedZoteroItem) {
            if (externalSourceId) {
                const externalReference = externalReferenceMap[externalSourceId];
                if (externalReference && externalReference.url) {
                    return (
                        <span>
                            (
                            <a href={externalReference.url} target="_blank" rel="noopener noreferrer">{citation}</a>
                            )
                        </span>
                    );
                }
            }
            return (<span>{`(${citation})`}</span>);
        }

        // External-file citations have no Zotero item to format and are excluded
        // from the bibliography. Preserve the cited page/section locator so the
        // export is as specific as the chat view. The host may upgrade this to a
        // clickable link to the locally stored file; the plain-text form is the
        // client-agnostic fallback when the host can't (e.g. no local copy).
        if (isExternalFile) {
            const locatorSuffix = hasLocatorDisplay ? `, p.${pagesDisplay}` : '';
            const exportedFile = getHost().documentExport?.renderExternalFileCitation?.({
                externalFileKey,
                displayName: citation,
                locatorSuffix,
                localPathsByExtKey: externalFileLocalPaths,
            });
            if (exportedFile && exportedFile.kind === 'html') {
                return <span dangerouslySetInnerHTML={{ __html: exportedFile.html }} />;
            }
            return (<span>{`(${citation}${locatorSuffix})`}</span>);
        }

        // For library citations, delegate host-native formatting (CSL for
        // Zotero) to the host. The host returns formatted HTML; the wrapping
        // element shape stays here so this component owns all the JSX.
        const exported = getHost().documentExport?.renderCitation({
            effectiveLibraryID,
            effectiveItemKey,
            requestedRef,
            pages,
            metadata: citationMetadata,
            pageLabelsByAttachmentId: labelsByAttachmentId,
        });
        if (!exported) return null;
        if (exported.kind === 'html') {
            return <span dangerouslySetInnerHTML={{ __html: exported.html }} />;
        }
        // Use dangerouslySetInnerHTML because the formatted citation is HTML
        // (e.g., "(<span class="citation-item">Author, 2024</span>)").
        return (
            <span
                className="citation"
                data-citation={exported.citationData}
                dangerouslySetInnerHTML={{ __html: exported.html }}
            />
        );
    }

    // Determine the CSS class based on citation type and state
    const isNoteCitation = citationMetadata?.citation_type === 'note';
    const isAnnotationCitation = citationMetadata?.citation_type === 'annotation';
    const isEpubCitation = getContentKind(citationMetadata) === 'epub';
    const hasEpubSymbolicLocator = isEpubCitation
        && getSymbolicLocation(citationMetadata)?.content_kind === 'epub';
    const isTextCitation = getContentKind(citationMetadata) === 'text';
    const isSnapshotCitation = getContentKind(citationMetadata) === 'snapshot';
    const symbolicLocationForDisplay = getSymbolicLocation(citationMetadata);
    const textLineLocation = isTextCitation && symbolicLocationForDisplay?.content_kind === 'text'
        ? symbolicLocationForDisplay
        : undefined;
    // Snapshots resolve a cited passage from the symbolic anchor/text, not pages
    // (the reader is a continuous scroll view); any synthetic page on the wire is
    // a coarse navigation hint only and is never shown.
    const hasSnapshotSymbolicLocator = isSnapshotCitation
        && symbolicLocationForDisplay?.content_kind === 'snapshot';
    const hasBoundingBoxes = !isNoteCitation && !isAnnotationCitation && !!citationMetadata && getCitationBoundingBoxes(citationMetadata).length > 0;
    // PDF/EPUB page-or-box locator. Snapshots are excluded here: they carry a
    // synthetic page that must not be presented as a PDF page locator.
    const hasLocator = !isNoteCitation && !isAnnotationCitation && !isSnapshotCitation
        && (pages.length > 0 || hasBoundingBoxes || hasEpubSymbolicLocator);
    const citationClassBase = isExternal && !mappedZoteroItem
        ? "zotero-citation external-citation"
        : (hasLocator || isAnnotationCitation || hasSnapshotSymbolicLocator) && !isExternalFile
        ? "zotero-citation with-locator"
        : "zotero-citation";
    const citationClass = isStreaming
        ? `${citationClassBase} streaming`
        : isInvalid
        ? `${citationClassBase} invalid`
        : citationClassBase;
    const showPreviewText = previewText && previewText !== citation;

    const citationElement = (
        <span 
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
                {hasLocatorDisplay && (
                    <span className="font-color-secondary text-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {`Page ${pagesDisplay}`}
                    </span>
                )}
                {(!pages || pages.length === 0) && textLineLocation && (
                    <span className="font-color-secondary text-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {textLineLocation.line_end && textLineLocation.line_end !== textLineLocation.line
                            ? `Lines ${textLineLocation.line}–${textLineLocation.line_end}`
                            : `Line ${textLineLocation.line}`}
                    </span>
                )}
            </span>
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
                                ? (hasLocatorDisplay ? `Opens EPUB at page ${pagesDisplay}` : 'Opens EPUB at location')
                                : hasBoundingBoxes
                                    ? (hasLocatorDisplay ? `Highlights passage on page ${pagesDisplay}` : 'Highlights passage in PDF')
                                    : (hasLocatorDisplay ? `Opens PDF on page ${pagesDisplay}` : 'Opens PDF at location')}
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
