import React from 'react';
import { useAtomValue } from 'jotai';
import { openSource, revealSource } from '../../utils/sourceUtils';
import { CSSItemTypeIcon, PdfIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ZoteroIcon } from '../icons/ZoteroIcon';
import { getPref } from '../../../src/utils/prefs';
import { CitationData, getUniqueKey, isExternalCitation } from '../../types/citations';
import Tooltip from '../ui/Tooltip';
import { externalReferenceMappingAtom, externalReferenceItemMappingAtom } from '../../atoms/externalReferences';
import ActionButtons from '../externalReferences/actionButtons';
import { ExternalReference } from '../../types/externalReferences';
import { ZoteroItemReference } from '../../types/zotero';

interface CitedSourcesListProps {
    citations: CitationData[];
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    citations
}) => {
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    const externalReferenceMapping = useAtomValue(externalReferenceMappingAtom);
    const externalItemMapping = useAtomValue(externalReferenceItemMappingAtom);
    
    // Helper to get external reference from mapping
    const getExternalReference = (citation: CitationData): ExternalReference | undefined => {
        if (!isExternalCitation(citation) || !citation.external_source_id) return undefined;
        return externalReferenceMapping[citation.external_source_id];
    };
    
    // Helper to get mapped Zotero item for external citations
    const getMappedZoteroItem = (citation: CitationData): ZoteroItemReference | undefined => {
        if (!isExternalCitation(citation) || !citation.external_source_id) return undefined;
        const mapping = externalItemMapping[citation.external_source_id];
        return mapping ?? undefined; // Convert null to undefined
    };
    
    return (
        <div className="mt-2 rounded-md border border-popup">
            <div className="space-y-3">
                {citations.map((citation, index) => {
                    const isExternal = isExternalCitation(citation);
                    const externalRef = getExternalReference(citation);
                    const mappedZoteroItem = getMappedZoteroItem(citation);
                    
                    // Only show as external if there's no mapped Zotero item
                    const showAsExternal = isExternal && !mappedZoteroItem;
                    
                    // Get item type icon for mapped external citations
                    const getMappedItemType = (): string | undefined => {
                        if (!mappedZoteroItem) return undefined;
                        const item = Zotero.Items.getByLibraryAndKey(mappedZoteroItem.library_id, mappedZoteroItem.zotero_key);
                        return item ? item.itemType : undefined;
                    };
                    const mappedItemType = isExternal && mappedZoteroItem ? getMappedItemType() : undefined;
                    
                    return (
                        <div key={getUniqueKey(citation)} className={`p-2 rounded-md display-flex flex-row ${index > 0 ? 'pt-0' : ''}`}>
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
                                        {showAsExternal ? (
                                            <></>
                                        ) : mappedItemType ? (
                                            <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                                <CSSItemTypeIcon className="scale-85" itemType={mappedItemType} />
                                            </span>
                                        ) : citation.icon && (
                                            <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                                <CSSItemTypeIcon className="scale-85" itemType={citation.icon} />
                                            </span>
                                        )}
                                        {/* Author-year heading */}
                                        <span className="truncate">
                                            {citation.name}
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
                                        ) : (
                                            <>
                                                <Tooltip content="Reveal in Zotero" singleLine>
                                                    <IconButton
                                                        icon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />}
                                                        variant="ghost-secondary"
                                                        onClick={() => revealSource(mappedZoteroItem || citation)}
                                                        ariaLabel="Reveal source"
                                                        title="Reveal in Zotero"
                                                        className="display-flex scale-11"
                                                        disabled={!mappedZoteroItem && citation.type !== "item" && citation.type !== "attachment"}
                                                    />
                                                </Tooltip>
                                                <Tooltip content="Open PDF" singleLine>
                                                    <IconButton
                                                        icon={PdfIcon}
                                                        variant="ghost-secondary"
                                                        onClick={async () => {
                                                            if (mappedZoteroItem) {
                                                                // Handle mapped external citation
                                                                const item = Zotero.Items.getByLibraryAndKey(
                                                                    mappedZoteroItem.library_id,
                                                                    mappedZoteroItem.zotero_key
                                                                );
                                                                if (item && item.isRegularItem()) {
                                                                    const bestAttachment = await item.getBestAttachment();
                                                                    if (bestAttachment) {
                                                                        Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
                                                                    }
                                                                } else if (item && item.isAttachment()) {
                                                                    Zotero.getActiveZoteroPane().viewAttachment(item.id);
                                                                }
                                                            } else {
                                                                openSource(citation);
                                                            }
                                                        }}
                                                        ariaLabel="Open PDF"
                                                        title="Open PDF"
                                                        className="display-flex scale-12"
                                                        disabled={!mappedZoteroItem && citation.type !== "attachment"}
                                                    />
                                                </Tooltip>
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

/**
 * Format a bibliographic citation string for external references
 * Similar format to Zotero library items: Authors. Year. "Title." Journal/Venue.
 */
function formatExternalCitation(ref: ExternalReference): string {
    const parts: string[] = [];
    
    // Authors
    if (ref.authors && ref.authors.length > 0) {
        const authorStr = ref.authors.length > 2 
            ? `${ref.authors[0]} et al.`
            : ref.authors.join(', ');
        parts.push(authorStr);
    }
    
    // Year
    if (ref.year) {
        parts.push(`${ref.year}.`);
    }
    
    // Title (in quotes)
    if (ref.title) {
        parts.push(`"${ref.title}."`);
    }
    
    // Venue/Journal
    if (ref.venue) {
        parts.push(ref.venue + '.');
    } else if (ref.journal?.name) {
        let journalPart = ref.journal.name;
        if (ref.journal.volume) {
            journalPart += ` ${ref.journal.volume}`;
            if (ref.journal.issue) {
                journalPart += ` (${ref.journal.issue})`;
            }
        }
        if (ref.journal.pages) {
            journalPart += `: ${ref.journal.pages}`;
        }
        parts.push(journalPart + '.');
    }
    
    return parts.join(' ');
}

export default CitedSourcesList;