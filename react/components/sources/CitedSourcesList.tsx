import React, { useMemo } from 'react';
import { openSource, revealSource } from '../../utils/sourceUtils';
import { CSSItemTypeIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ZoteroIcon } from '../icons/ZoteroIcon';
import { getPref } from '../../../src/utils/prefs';
import { CitationData } from '../../types/citations';

interface CitedSourcesListProps {
    saveAsNote: (source?: CitationData) => Promise<void>;
    citations: CitationData[];
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    saveAsNote,
    citations
}) => {
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    
    
    
    return (
        <div className="mt-2 rounded-md border border-popup">
            <div className="space-y-3">
                {citations.map((citation, index) => (
                    <div key={`${citation.library_id}-${citation.zotero_key}`} className={`p-2 rounded-md display-flex flex-row ${index > 0 ? 'pt-0' : ''}`}>
                        {/* Left column */}
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
                                    {citation.icon &&
                                        <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                            <CSSItemTypeIcon className="scale-85" itemType={citation.icon} />
                                        </span>
                                    }
                                    <span className="truncate">
                                        {citation.name}
                                    </span>
                                </div>
                                <div className="display-flex gap-4 flex-shrink-0 p-2">
                                    {citation.parentKey &&
                                        <IconButton
                                            icon={() => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={10} />}
                                            variant="ghost-secondary"
                                            onClick={() => saveAsNote(citation)}
                                            ariaLabel="Save as Item Note"
                                            title="Save as Item Note"
                                            className="display-flex scale-11"
                                        />
                                    }
                                    <IconButton
                                        icon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />}
                                        variant="ghost-secondary"
                                        onClick={() => revealSource(citation)}
                                        ariaLabel="Reveal source"
                                        title="Reveal in Zotero"
                                        className="display-flex scale-11"
                                    />
                                    <IconButton
                                        icon={() => <ZoteroIcon icon={ZOTERO_ICONS.OPEN} size={10} />}
                                        variant="ghost-secondary"
                                        onClick={() => openSource(citation)}
                                        ariaLabel="Open source"
                                        title="Open"
                                        className="display-flex scale-12"
                                    />
                                </div>
                            </div>

                            {/* Right bottom section */}
                            <div className="flex-1 px-2 text-sm font-color-secondary
                                            min-w-0 overflow-hidden text-ellipsis">
                                {citation.formatted_citation}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default CitedSourcesList;