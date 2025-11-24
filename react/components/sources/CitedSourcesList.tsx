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
import { externalReferenceMappingAtom } from '../../atoms/externalReferences';
import ActionButtons from '../externalReferences/actionButtons';
import { ExternalReference } from '../../types/externalReferences';

interface CitedSourcesListProps {
    citations: CitationData[];
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    citations
}) => {
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    const externalReferenceMapping = useAtomValue(externalReferenceMappingAtom);
    
    // Helper to get external reference from mapping
    const getExternalReference = (citation: CitationData): ExternalReference | undefined => {
        if (!isExternalCitation(citation) || !citation.external_source_id) return undefined;
        return externalReferenceMapping[citation.external_source_id];
    };
    
    return (
        <div className="mt-2 rounded-md border border-popup">
            <div className="space-y-3">
                {citations.map((citation, index) => {
                    const isExternal = isExternalCitation(citation);
                    const externalRef = getExternalReference(citation);
                    
                    return (
                        <div key={getUniqueKey(citation)} className={`p-2 rounded-md display-flex flex-row ${index > 0 ? 'pt-0' : ''}`}>
                            {/* Left column - numeric citation */}
                            {!authorYearFormat &&
                                <div className="p-2">
                                    <div className="source-citation text-sm">
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
                                        {isExternal ? (
                                            <></>
                                            // <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                            //     <LinkIcon className="scale-75 font-color-secondary" />
                                            // </span>
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
                                        {isExternal && externalRef ? (
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
                                                        onClick={() => revealSource(citation)}
                                                        ariaLabel="Reveal source"
                                                        title="Reveal in Zotero"
                                                        className="display-flex scale-11"
                                                        disabled={citation.type !== "item" && citation.type !== "attachment"}
                                                    />
                                                </Tooltip>
                                                <Tooltip content="Open PDF" singleLine>
                                                    <IconButton
                                                        // icon={() => <ZoteroIcon icon={ZOTERO_ICONS.OPEN} size={10} />}
                                                        icon={PdfIcon}
                                                        variant="ghost-secondary"
                                                        onClick={() => openSource(citation)}
                                                        ariaLabel="Open PDF"
                                                        title="Open PDF"
                                                        className="display-flex scale-12"
                                                        disabled={citation.type !== "attachment"}
                                                    />
                                                </Tooltip>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Right bottom section - formatted citation */}
                                <div className="flex-1 px-2 text-sm font-color-secondary
                                                min-w-0 overflow-hidden text-ellipsis">
                                    {isExternal && externalRef 
                                        ? formatExternalCitation(externalRef)
                                        : citation.formatted_citation
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