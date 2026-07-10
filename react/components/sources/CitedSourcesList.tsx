import React, { useState, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { CSSItemTypeIcon, ExternalLinkIcon, PdfIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ZoteroIcon } from '../icons/ZoteroIcon';
import {
    CitedSource,
    getCitationKey,
    getRequestedRef,
    getResolvedRef,
    isExternalCitation,
    isExternalFileCitation,
    itemTypeToIconName,
} from '../../types/citations';
import Tooltip from '../ui/Tooltip';
import { externalReferenceMappingAtom, externalReferenceItemMappingAtom, formatExternalCitation } from '../../atoms/externalReferences';
import { ExternalReference } from '../../types/externalReferences';
import { ZoteroItemReference } from '../../types/zotero';
import { getHost, type ResolvedItemDisplay } from '../../host';

interface CitedSourcesListProps {
    citations: CitedSource[];
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    citations
}) => {
    const authorYearFormat = (getHost().config?.citationFormat() ?? 'author-year') !== 'numeric';
    const externalReferenceMapping = useAtomValue(externalReferenceMappingAtom);
    const externalItemMapping = useAtomValue(externalReferenceItemMappingAtom);

    // Per-citation display metadata (icon item type + attachment availability),
    // resolved via the host. Rows render from citation v2 metadata alone; this
    // only backs the icon for mapped external citations and the PDF-button
    // enabled state, neither of which is in the citation metadata yet.
    const [displayMetaByKey, setDisplayMetaByKey] = useState<Map<string, ResolvedItemDisplay>>(new Map());

    useEffect(() => {
        let cancelled = false;

        const resolveDisplayMeta = async () => {
            const itemData = getHost().itemData;
            if (!itemData?.resolveItemDisplay) {
                setDisplayMetaByKey(new Map());
                return;
            }

            const next = new Map<string, ResolvedItemDisplay>();
            for (const citation of citations) {
                if (cancelled) return;
                // Resolve only where a row needs host data: mapped external
                // citations (icon item type) and item citations (attachment
                // availability for the PDF button).
                let ref: ZoteroItemReference | undefined;
                if (isExternalCitation(citation)) {
                    const sourceId = getExternalSourceId(citation);
                    const mapped = sourceId ? externalItemMapping[sourceId] : null;
                    ref = mapped ?? undefined;
                } else if (citation.citation_type === 'item') {
                    ref = getZoteroReference(citation);
                }
                if (!ref) continue;

                const meta = await itemData.resolveItemDisplay(ref);
                if (cancelled) return;
                if (meta) next.set(getCitationKey(citation), meta);
            }

            if (!cancelled) setDisplayMetaByKey(next);
        };

        resolveDisplayMeta();

        return () => {
            cancelled = true;
        };
    }, [citations, externalItemMapping]);

    // Helper to get external reference from mapping
    const getExternalReference = (citation: CitedSource): ExternalReference | undefined => {
        const externalSourceId = getExternalSourceId(citation);
        if (!isExternalCitation(citation) || !externalSourceId) return undefined;
        return externalReferenceMapping[externalSourceId];
    };

    // Helper to get mapped Zotero item for external citations
    const getMappedZoteroItem = (citation: CitedSource): ZoteroItemReference | undefined => {
        const externalSourceId = getExternalSourceId(citation);
        if (!isExternalCitation(citation) || !externalSourceId) return undefined;
        const mapping = externalItemMapping[externalSourceId];
        return mapping ?? undefined; // Convert null to undefined
    };

    // Check if PDF button should be enabled for a citation
    const isPdfButtonEnabled = (citation: CitedSource, mappedZoteroItem: ZoteroItemReference | undefined): boolean => {
        const zoteroRef = getZoteroReference(citation);
        if (mappedZoteroItem) return true;
        if (citation.citation_type === "attachment" && zoteroRef) return true;
        if (citation.citation_type === "item") {
            return !!displayMetaByKey.get(getCitationKey(citation))?.hasReadableAttachment;
        }
        return false;
    };

    // Filter out invalid citations
    const validCitations = citations.filter(citation => !citation.invalid);

    return (
        <div className="mt-2 rounded-md border border-popup">
            <div className="space-y-3">
                {validCitations.map((citation, index) => {
                    const isExternal = isExternalCitation(citation);
                    const isExternalFile = isExternalFileCitation(citation);
                    const externalRef = getExternalReference(citation);
                    const mappedZoteroItem = getMappedZoteroItem(citation);
                    const zoteroRef = getZoteroReference(citation);

                    // Only show as external if there's no mapped Zotero item
                    const showAsExternal = isExternal && !mappedZoteroItem;

                    // Item type icon for mapped external citations comes from the
                    // host-resolved display meta (not a render-time Zotero read).
                    const mappedItemType = isExternal && mappedZoteroItem
                        ? displayMetaByKey.get(getCitationKey(citation))?.itemType
                        : undefined;

                    // Legacy item citations (pre-citation-v2) carry no item_type,
                    // so the icon would fall back to the generic document glyph.
                    // Reuse the item type the host already resolves for the
                    // PDF-button state (no extra lookup) to recover the precise
                    // icon; when absent (non-Zotero host / unresolvable) the
                    // metadata value stands.
                    const resolvedItemType = displayMetaByKey.get(getCitationKey(citation))?.itemType;

                    // Icon from citation metadata alone (citation v2), falling
                    // back to the host-resolved item type for legacy citations.
                    const iconName = showAsExternal
                        ? undefined
                        : mappedItemType ?? itemTypeToIconName(citation.item_type ?? resolvedItemType, citation.content_kind);

                    return (
                        <div key={getCitationKey(citation)} className={`p-2 rounded-md display-flex flex-row ${index > 0 ? 'pt-0' : ''}`}>
                            {/* Left column - numeric citation */}
                            {!authorYearFormat &&
                                <div className="p-2">
                                    <div className={`source-citation text-sm ${showAsExternal ? 'mt-020 source-citation-external' : ''}`}>
                                        {citation.numericCitation}
                                    </div>
                                </div>
                            }

                            {/* Right column */}
                            <div className="display-flex flex-col justify-between w-full min-w-0">
                                {/* Right top section */}
                                <div className="display-flex flex-row w-full items-center min-w-0">

                                    <div className="display-flex flex-1 min-w-0 p-2">
                                        {/* Icon */}
                                        {iconName && (
                                            <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                                <CSSItemTypeIcon className="scale-85" itemType={iconName} />
                                            </span>
                                        )}
                                        {/* Author-year heading */}
                                        <span className="truncate">
                                            {citation.display_name}
                                        </span>
                                    </div>

                                    {/* Action buttons */}
                                    <div className="display-flex gap-4 flex-shrink-0 p-2">
                                        {showAsExternal && externalRef ? (
                                            getHost().components?.externalReferenceActions({
                                                item: externalRef,
                                                buttonVariant: 'ghost-secondary',
                                                revealButtonMode: 'icon-only',
                                                importButtonMode: 'none',
                                                detailsButtonMode: 'icon-only',
                                                webButtonMode: 'icon-only',
                                                pdfButtonMode: 'icon-only',
                                                showCitationCount: false,
                                                className: 'scale-12',
                                            })
                                        ) : isExternalFile ? (
                                            <Tooltip content="Open file" singleLine>
                                                <IconButton
                                                    icon={ExternalLinkIcon}
                                                    variant="ghost-secondary"
                                                    onClick={() => {
                                                        const ref = getDisplayRef(citation);
                                                        if (ref?.kind === 'external_file') {
                                                            getHost().navigation?.launchExternalFile(ref.ext_key);
                                                        }
                                                    }}
                                                    ariaLabel="Open file"
                                                    title="Open file"
                                                    className="display-flex scale-11"
                                                />
                                            </Tooltip>
                                        ) : (
                                            <>
                                                <Tooltip content="Reveal in Zotero" singleLine>
                                                    <IconButton
                                                        icon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />}
                                                        variant="ghost-secondary"
                                                        onClick={() => {
                                                            const target = mappedZoteroItem || zoteroRef;
                                                            if (target) getHost().navigation?.revealInLibrary(target);
                                                        }}
                                                        ariaLabel="Reveal source"
                                                        title="Reveal in Zotero"
                                                        className="display-flex scale-11"
                                                        disabled={!mappedZoteroItem && !zoteroRef}
                                                    />
                                                </Tooltip>
                                                {citation.citation_type !== "note" && (
                                                    <Tooltip content="Open PDF" singleLine>
                                                        <IconButton
                                                            icon={PdfIcon}
                                                            variant="ghost-secondary"
                                                            onClick={() => {
                                                                const target = mappedZoteroItem || zoteroRef;
                                                                if (target) getHost().navigation?.openSource(target);
                                                            }}
                                                            ariaLabel="Open PDF"
                                                            title="Open PDF"
                                                            className="display-flex scale-12"
                                                            disabled={!isPdfButtonEnabled(citation, mappedZoteroItem)}
                                                        />
                                                    </Tooltip>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Right bottom section - formatted citation */}
                                <div className="flex-1 px-2 text-sm font-color-secondary
                                                min-w-0 overflow-hidden text-ellipsis">
                                    {showAsExternal && externalRef
                                        ? formatExternalCitation(externalRef)
                                        : stripUrlsFromCitation(citation.formatted_citation)
                                    }
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

/**
 * Return the citation identity used for source-list actions and lookups.
 */
function getDisplayRef(citation: CitedSource) {
    return getResolvedRef(citation) ?? getRequestedRef(citation);
}

/**
 * Resolve a Zotero item reference from the citation's structured identity.
 */
function getZoteroReference(citation: CitedSource): ZoteroItemReference | undefined {
    const ref = getDisplayRef(citation);
    if (ref?.kind === 'zotero') {
        return {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            library_ref: ref.library_ref,
        };
    }
    return undefined;
}

/**
 * Resolve the external reference cache key for the active citation identity.
 */
function getExternalSourceId(citation: CitedSource): string | undefined {
    const ref = getDisplayRef(citation);
    if (ref?.kind === 'external') return ref.external_id;
    return undefined;
}

/**
 * Remove URLs from a formatted citation string
 */
function stripUrlsFromCitation(citation: string | null | undefined): string {
    if (!citation) return '';
    // Remove URLs (http/https) and clean up trailing punctuation/whitespace
    return citation
        .replace(/https?:\/\/[^\s]+/g, '')
        .replace(/\s+\.$/, '.')  // Clean up " ." at end
        .replace(/\s{2,}/g, ' ') // Collapse multiple spaces
        .trim();
}

export default CitedSourcesList;
