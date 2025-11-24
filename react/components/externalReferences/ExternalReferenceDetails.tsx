import React from 'react';
import { ExternalReference } from '../../types/externalReferences';
import { ExternalReferenceResult } from '../../types/chat/apiTypes';
import { formatAuthors } from './utils';
import ActionButtons from './actionButtons';

interface ExternalReferenceDetailsProps {
    item: ExternalReference | ExternalReferenceResult;
}

const ExternalReferenceDetails: React.FC<ExternalReferenceDetailsProps> = ({ item }) => {
    const authors = formatAuthors(item.authors);
    const publicationTitle = item.journal?.name || item.venue;
    const year = item.year;

    return (
        <div className="display-flex flex-col h-full overflow-hidden">
            <div className="display-flex flex-col gap-1 px-4 py-2 shrink-0">
                <div className="text-lg font-bold font-color-primary leading-tight pr-8">{item.title || 'Untitled Item'}</div>
                {authors && (
                    <div className="font-color-primary">{authors}</div>
                )}
                {(publicationTitle || year) && (
                    <div className="font-color-secondary">
                        {publicationTitle && <i>{publicationTitle}</i>}
                        {publicationTitle && year && ', '}
                        {year}
                    </div>
                )}
            </div>

            {item.abstract && (
                <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
                        <div className="display-flex flex-col gap-1">
                            <div className="font-bold font-color-primary uppercase tracking-wider sticky top-0 z-10 pb-1">Abstract</div>
                            <div className="font-color-primary leading-relaxed select-text">
                                {item.abstract.trim()}
                            </div>
                        </div>
                </div>
            )}

            <div className="p-4 pt-3 border-t border-quaternary shrink-0">
                <ActionButtons item={item} detailsButtonMode="none" />
            </div>
        </div>
    );
};

export default ExternalReferenceDetails;
