import React from 'react';
import { InputSource, SourceCitation } from '../../types/sources';
import { openSource, revealSource } from '../../utils/sourceUtils';
import { CSSItemTypeIcon } from '../icons/icons';
import IconButton from '../ui/IconButton';
import { ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { ZoteroIcon } from '../icons/ZoteroIcon';
import { getPref } from '../../../src/utils/prefs';
import { sourceCitationsAtom } from '../../atoms/citations';
import { useAtomValue } from 'jotai';

interface CitedSourcesListProps {
    saveAsNote: (source?: SourceCitation) => Promise<void>;
}

const CitedSourcesList: React.FC<CitedSourcesListProps> = ({
    saveAsNote
}) => {
    const sources = useAtomValue(sourceCitationsAtom);
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    
    return (
        <div className="mt-2 mx-3 bg-quaternary rounded-md border border-quinary">
            <div className="space-y-3">
                {sources.map((source, index) => (
                    <div key={source.id} className={`p-2 rounded-md display-flex flex-row ${index > 0 ? 'pt-0' : ''}`}>
                        {/* Left column */}
                        {!authorYearFormat &&
                            <div className="p-2">
                                <div className="source-citation text-sm">
                                    {source.numericCitation}
                                </div>
                            </div>
                        }

                        {/* Right column */}
                        <div className="display-flex flex-col justify-between w-full min-w-0">
                            {/* Right top section */}
                            <div className="display-flex flex-row w-full items-center min-w-0">
                                
                                <div className="display-flex flex-1 min-w-0 p-2">
                                    {source.icon &&
                                        <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                            <CSSItemTypeIcon className="scale-85" itemType={source.icon} />
                                        </span>
                                    }
                                    <span className="truncate">
                                        {source.name}
                                    </span>
                                </div>
                                <div className="display-flex gap-4 flex-shrink-0 p-2">
                                    {source.parentKey &&
                                        <IconButton
                                            icon={() => <ZoteroIcon icon={ZOTERO_ICONS.NOTES} size={10} />}
                                            variant="ghost-secondary"
                                            onClick={() => saveAsNote(source)}
                                            ariaLabel="Save as Item Note"
                                            title="Save as Item Note"
                                            className="display-flex scale-11"
                                        />
                                    }
                                    <IconButton
                                        icon={() => <ZoteroIcon icon={ZOTERO_ICONS.SHOW_ITEM} size={10} />}
                                        variant="ghost-secondary"
                                        onClick={() => revealSource(source)}
                                        ariaLabel="Reveal source"
                                        title="Reveal in Zotero"
                                        className="display-flex scale-11"
                                    />
                                    <IconButton
                                        icon={() => <ZoteroIcon icon={ZOTERO_ICONS.OPEN} size={10} />}
                                        variant="ghost-secondary"
                                        onClick={() => openSource(source)}
                                        ariaLabel="Open source"
                                        title="Open"
                                        className="display-flex scale-12"
                                    />
                                </div>
                            </div>

                            {/* Right bottom section */}
                            <div className="flex-1 px-2 text-sm font-color-secondary
                                            min-w-0 overflow-hidden text-ellipsis">
                                {source.formatted_citation}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default CitedSourcesList;