import React, { useState, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { openSource, revealSource } from '../../utils/sourceUtils';
import { CSSItemTypeIcon, PdfIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ZoteroIcon } from '../icons/ZoteroIcon';
import { getPref } from '../../../src/utils/prefs';
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
import ActionButtons from '../externalReferences/actionButtons';
import { ExternalReference } from '../../types/externalReferences';
import { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';

interface CitedSourcesListProps {
    citations: CitedSource[];
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    citations
}) => {
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    const externalReferenceMapping = useAtomValue(externalReferenceMappingAtom);
    const externalItemMapping = useAtomValue(externalReferenceItemMappingAtom);

    // Track which item citations have best attachments available
    const [itemsWithBestAttachment, setItemsWithBestAttachment] = useState<Set<string>>(new Set());

    // Check for best attachments on item citations (interactivity only — the
    // rows themselves render from citation metadata without Zotero access)
    useEffect(() => {
        let cancelled = false;

        const checkBestAttachments = async () => {
            const newSet = new Set<string>();

            for (const citation of citations) {
                if (cancelled) return;
                const zoteroRef = getZoteroReference(citation);
                if (citation.citation_type === "item" && zoteroRef) {
                    try {
                        const item = Zotero.Items.getByLibraryAndKey(zoteroRef.library_id, zoteroRef.zotero_key);
                        if (item && item.isRegularItem()) {
                            const bestAttachment = await item.getBestAttachment();
                            if (bestAttachment) {
                                newSet.add(getCitationKey(citation));
                            }
                        }
                    } catch (e) {
                        logger(`CitedSourcesList: Item not loaded for ${zoteroRef.library_id}/${zoteroRef.zotero_key}: ${e}`);
                    }
                }
            }

            if (!cancelled) {
                setItemsWithBestAttachment(newSet);
            }
        };

        checkBestAttachments();

        return () => {
            cancelled = true;
        };
    }, [citations]);

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
        if (citation.citation_type === "item" && itemsWithBestAttachment.has(getCitationKey(citation))) return true;
        return false;
    };

    // Open the locally stored copy of an external-file citation (quiet no-op
    // when the file was attached on another computer)
    const openExternalFile = async (citation: CitedSource) => {
        const ref = getDisplayRef(citation);
        if (ref?.kind !== 'external_file') return;
        try {
            const record = await Zotero.Beaver?.db?.getExternalFileByKey(ref.ext_key);
            const path = record?.storedPath ?? null;
            if (path && (await IOUtils.exists(path).catch(() => false))) {
                Zotero.launchFile(path);
            } else {
                logger(`CitedSourcesList: External file ext-${ref.ext_key} has no local copy`);
            }
        } catch (e) {
            logger(`CitedSourcesList: Failed to open external file: ${e}`, 2);
        }
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

                    // Get item type icon for mapped external citations
                    const getMappedItemType = (): string | undefined => {
                        if (!mappedZoteroItem) return undefined;
                        try {
                            const item = Zotero.Items.getByLibraryAndKey(mappedZoteroItem.library_id, mappedZoteroItem.zotero_key);
                            return item ? item.itemType : undefined;
                        } catch (e) {
                            logger(`CitedSourcesList: Item not loaded for ${mappedZoteroItem.library_id}/${mappedZoteroItem.zotero_key}: ${e}`);
                            return undefined;
                        }
                    };
                    const mappedItemType = isExternal && mappedZoteroItem ? getMappedItemType() : undefined;

                    // Icon from citation metadata alone (citation v2)
                    const iconName = showAsExternal
                        ? undefined
                        : mappedItemType ?? itemTypeToIconName(citation.item_type, citation.content_kind);

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
                                            <ActionButtons
                                                item={externalRef}
                                                buttonVariant="ghost-secondary"
                                                revealButtonMode="icon-only"
                                                importButtonMode="none"
                                                detailsButtonMode="icon-only"
                                                webButtonMode="icon-only"
                                                pdfButtonMode="icon-only"
                                                showCitationCount={false}
                                                className="scale-12"
                                            />
                                        ) : isExternalFile ? (
                                            <Tooltip content="Open file" singleLine>
                                                <IconButton
                                                    icon={PdfIcon}
                                                    variant="ghost-secondary"
                                                    onClick={() => openExternalFile(citation)}
                                                    ariaLabel="Open file"
                                                    title="Open file"
                                                    className="display-flex scale-12"
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
                                                            if (target) revealSource(target);
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
                                                            onClick={async () => {
                                                                const target = mappedZoteroItem || zoteroRef;
                                                                if (!target) return;
                                                                try {
                                                                    const item = Zotero.Items.getByLibraryAndKey(
                                                                        target.library_id,
                                                                        target.zotero_key
                                                                    );
                                                                    if (item && item.isRegularItem()) {
                                                                        const bestAttachment = await item.getBestAttachment();
                                                                        if (bestAttachment) {
                                                                            Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
                                                                        }
                                                                    } else if (item && item.isAttachment()) {
                                                                        Zotero.getActiveZoteroPane().viewAttachment(item.id);
                                                                    } else {
                                                                        await openSource(target);
                                                                    }
                                                                } catch (e) {
                                                                    logger(`CitedSourcesList: Item not loaded, falling back to openSource: ${e}`);
                                                                    await openSource(target);
                                                                }
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
