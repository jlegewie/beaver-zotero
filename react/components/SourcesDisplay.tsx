import React from 'react';
import { SourceWithCitations } from '../types/sources';
import { openSource, revealSource } from '../utils/sourceUtils';
import { CSSItemTypeIcon } from './icons';
import Button from './Button';
import { ZOTERO_ICONS } from './icons/ZoteroIcon';
import { ZoteroIcon } from './icons/ZoteroIcon';

interface SourcesDisplayProps {
    sources: SourceWithCitations[];
}

const SourcesDisplay: React.FC<SourcesDisplayProps> = ({
    sources
}) => {
    return (
        <div className="mt-2 mx-3 bg-quaternary rounded-md border border-quinary">
            <div className="space-y-3">
                {sources.map((source, index) => (
                    <div key={source.id} className={`p-2 rounded-md flex flex-row ${index > 0 ? 'pt-0' : ''}`}>
                        {/* Left column */}
                        <div className="p-2">
                            <div className="source-citation text-sm">
                                {source.numericCitation}
                            </div>
                        </div>

                        {/* Right column */}
                        <div className="flex flex-col justify-between w-full min-w-0">
                            {/* Right top section */}
                            <div className="flex flex-row w-full items-center min-w-0">
                                
                                <div className="flex flex-1 min-w-0 p-2">
                                    {source.icon &&
                                        <span className="mr-2 flex-shrink-0" style={{ transform: 'translateY(-2px)' }}>
                                            <CSSItemTypeIcon className="scale-85" itemType={source.icon} />
                                        </span>
                                    }
                                    <span className="truncate">
                                        {source.citation}
                                    </span>
                                </div>
                                <div className="flex gap-2 flex-shrink-0">
                                    <Button
                                        variant="outline"
                                        className="text-xs py-1 px-2 scale-90"
                                        onClick={() => revealSource(source)}
                                    >
                                        <ZoteroIcon 
                                            icon={ZOTERO_ICONS.SHOW_ITEM} 
                                            size={12}
                                        />
                                        Reveal
                                    </Button>
                                    <Button
                                        variant="outline"
                                        className="text-xs py-1 px-2 scale-90"
                                        onClick={() => openSource(source)}
                                    >
                                        <ZoteroIcon 
                                            icon={ZOTERO_ICONS.OPEN} 
                                            size={12}
                                        />
                                        Open
                                    </Button>
                                </div>
                            </div>

                            {/* Right bottom section */}
                            <div className="flex-1 px-2 text-sm font-color-secondary
                                            min-w-0 overflow-hidden text-ellipsis">
                                {source.reference}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default SourcesDisplay;