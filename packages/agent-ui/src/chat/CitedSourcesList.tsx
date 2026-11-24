import React, { useState, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { ArrowUpRightIcon, ExternalLinkIcon, FileIcon, Icon, LibraryIcon, PdfIcon, TableIcon } from '../icons';
import IconButton from '../primitives/IconButton';
import {
    CitedSource,
    getCitationKey,
    getRequestedRef,
    getResolvedRef,
    isExternalCitation,
    isExternalFileCitation,
    itemTypeToIconName,
} from '@beaver/agent-core/types/citations';
import Tooltip from '../primitives/Tooltip';
import { externalReferenceMappingAtom, externalReferenceItemMappingAtom, formatExternalCitation } from '@beaver/agent-core/citations/externalReferences';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { webPageId } from '@beaver/agent-core/citations/externalRecords';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { getHost, type ResolvedItemDisplay } from '../host';
import { useItemContextMenu } from './useItemContextMenu';

interface CitedSourcesListProps {
    citations: CitedSource[];
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    citations
}) => {
    const authorYearFormat = (getHost().config?.citationFormat() ?? 'author-year') !== 'numeric';
    const externalReferenceMapping = useAtomValue(externalReferenceMappingAtom);
    const externalItemMapping = useAtomValue(externalReferenceItemMappingAtom);
    const { openItemMenu, itemMenu } = useItemContextMenu();

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
        <div className="mt-2 rounded-card border border-card">
            <div className="space-y-3">
                {validCitations.map((citation, index) => {
                    const isExternal = isExternalCitation(citation);
                    const isExternalFile = isExternalFileCitation(citation);
                    // A table's cells and rows list as the table.
                    const table = citation.citation_type === 'table' ? citation.table : undefined;
                    const externalRef = getExternalReference(citation);
                    const mappedZoteroItem = getMappedZoteroItem(citation);
                    const zoteroRef = getZoteroReference(citation);

                    // Only show as external if there's no mapped Zotero item
                    const showAsExternal = isExternal && !mappedZoteroItem;
                    // The library item a right-click acts on; none for unmapped external sources.
                    const menuTarget = isExternalFile ? undefined : mappedZoteroItem || zoteroRef;

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
                        <div
                            key={getCitationKey(citation)}
                            className={`p-2 rounded-md display-flex flex-row ${index > 0 ? 'pt-0' : ''}`}
                            onContextMenu={menuTarget ? (event) => openItemMenu(menuTarget, event) : undefined}
                        >
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
                                        {table ? (
                                            <span className="mr-2 flex-shrink-0 display-flex items-center font-color-secondary">
                                                <Icon icon={TableIcon} />
                                            </span>
                                        ) : iconName && (
                                            <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                                {/* The client owns its item-type artwork; the generic
                                                    document glyph is the honest fallback when it has none. */}
                                                {getHost().components?.itemTypeIcon({ itemType: iconName, className: 'scale-85' })
                                                    ?? <Icon icon={FileIcon} className="scale-85" />}
                                            </span>
                                        )}
                                        {/* Author-year heading */}
                                        <span className="truncate">
                                            {table ? table.title : citation.display_name}
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
                                                        icon={() => (
                                                            <>
                                                                {getHost().components?.revealInLibraryIcon({})
                                                                    ?? <Icon icon={LibraryIcon} />}
                                                            </>
                                                        )}
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
                                                {table && zoteroRef && (
                                                    <Tooltip content="Open table" singleLine>
                                                        <IconButton
                                                            icon={ArrowUpRightIcon}
                                                            variant="ghost-secondary"
                                                            onClick={(event) => {
                                                                void getHost().navigation?.openTable?.(
                                                                    `${zoteroRef.library_ref ?? zoteroRef.library_id}-${zoteroRef.zotero_key}`,
                                                                    event.currentTarget.ownerDocument.defaultView,
                                                                );
                                                            }}
                                                            ariaLabel="Open table"
                                                            title="Open table"
                                                            className="display-flex scale-11"
                                                        />
                                                    </Tooltip>
                                                )}
                                                {citation.citation_type !== "note" && !table && (
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
                                    {showAsExternal && externalRef && !webPageId(externalRef.source_id)
                                        ? formatExternalCitation(externalRef)
                                        : table
                                        ? 'Research table'
                                        : stripUrlsFromCitation(citation.formatted_citation)
                                    }
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
            {itemMenu}
        </div>
    );
};

/**
 * The keys a record names its work by: its DOI, an arXiv id as the DataCite
 * DOI arXiv registers (version dropped), and its PMID — the same rules the
 * backend uses to list a web page as its paper.
 */
export function workKeys(reference: ExternalReference | undefined): string[] {
    const ids = reference?.identifiers;
    if (!ids) return [];
    const keys: string[] = [];
    const doi = typeof ids.doi === 'string' ? ids.doi.trim().toLowerCase() : '';
    if (doi) keys.push(doi);
    const arxiv = typeof ids.arXivID === 'string'
        ? ids.arXivID.trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '').toLowerCase()
        : '';
    if (arxiv) keys.push(`10.48550/arxiv.${arxiv}`);
    const pmid = typeof ids.pmid === 'string' ? ids.pmid.trim() : '';
    if (/^\d+$/.test(pmid)) keys.push(`pmid:${Number(pmid)}`);
    return keys;
}

/**
 * One entry per work: a web page whose record names a work (a DOI, an arXiv
 * id or a PMID: a journal landing page, an arXiv page, a PDF link) merges into
 * another cited external record of that work, or into an earlier web page of
 * it. The backend lists such a page as the paper, so the two entries would
 * show the same work. The entry kept shows the numeric markers of both, since
 * each was cited under its own.
 */
export function mergeWebPagesByDoi(
    citations: CitedSource[],
    references: Record<string, ExternalReference>,
): CitedSource[] {
    const keysOf = (citation: CitedSource): string[] => {
        const id = getExternalSourceId(citation);
        return id ? workKeys(references[id]) : [];
    };
    const isWebPage = (citation: CitedSource) => !!webPageId(getExternalSourceId(citation));
    const merged = citations.map((citation) => ({ ...citation }));
    const keeperByKey = new Map<string, CitedSource>();
    const claim = (citation: CitedSource, keys: string[]) => {
        for (const key of keys) if (!keeperByKey.has(key)) keeperByKey.set(key, citation);
    };
    // Works first, so a page merges into the work even when the page was cited first.
    for (const citation of merged) if (!isWebPage(citation)) claim(citation, keysOf(citation));
    const dropped = new Set<CitedSource>();
    for (const citation of merged) {
        if (!isWebPage(citation)) continue;
        const keys = keysOf(citation);
        const keeper = keys.map((key) => keeperByKey.get(key)).find(Boolean);
        if (!keeper) {
            claim(citation, keys);
            continue;
        }
        dropped.add(citation);
        const markers = [keeper.numericCitation, citation.numericCitation].filter((marker): marker is string => !!marker);
        const numbers = [...new Set(markers.join(', ').split(', '))].sort((a, b) => Number(a) - Number(b));
        keeper.numericCitation = numbers.length ? numbers.join(', ') : null;
    }
    return merged.filter((citation) => !dropped.has(citation));
}

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
