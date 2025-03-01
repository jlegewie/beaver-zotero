import React from 'react';
import { SourceWithCitations } from '../types/sources';
import { openSource, revealSource } from '../utils/sourceUtils';
import { CSSItemTypeIcon } from './icons';
import Button from './Button';

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
                        <div className="flex flex-col justify-between items-center">
                            {/* Right top section */}
                            <div className="flex flex-row w-full items-center">
                                
                                <div className="flex-1 p-2 inline-flex">
                                    {source.icon &&
                                        <span className="scale-90 mr-2" style={{ transform: 'translateY(-2px)' }}>
                                            <CSSItemTypeIcon itemType={source.icon} />
                                        </span>
                                    }
                                    {source.citation}
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        className="text-xs py-1 px-2 scale-90"
                                        onClick={() => revealSource(source)}
                                    >
                                        Reveal
                                    </Button>
                                    <Button
                                        variant="outline"
                                        className="text-xs py-1 px-2 scale-90"
                                        onClick={() => openSource(source)}
                                    >
                                        Open
                                    </Button>
                                </div>
                            </div>

                            {/* Right bottom section */}
                            <div className="flex-1 px-2 text-sm font-color-secondary">
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