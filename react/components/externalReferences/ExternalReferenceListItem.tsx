import React, { useCallback } from 'react';
import { ExternalReference } from '../../types/externalReferences';
import { ExternalReferenceResult } from '../../types/chat/apiTypes';
import { formatAuthors } from './utils';
import ActionButtons from './actionButtons';

interface ExternalReferenceItemPListrops {
    item: ExternalReference | ExternalReferenceResult;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

const ExternalReferenceListItem: React.FC<ExternalReferenceItemPListrops> = ({
    item,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className,
}) => {
    const authors = formatAuthors(item.authors);
    const publicationTitle = item.journal?.name || item.venue;
    const year = item.year;

    const baseClasses = [
        'px-3',
        'py-2',
        'display-flex',
        'flex-col',
        'gap-1',
        'cursor-pointer',
        'rounded-sm',
        'transition',
        'user-select-none',
    ];

    if (isHovered) {
        baseClasses.push('bg-quinary');
    }

    const handleClick = useCallback(() => {
        // Future: Navigate to item or show details
    }, []);

    return (
        <div
            className={`${baseClasses.join(' ')} ${className}`}
            onClick={handleClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="display-flex flex-row items-start gap-3">
                <div className="display-flex flex-col flex-1 gap-1 min-w-0 font-color-primary">
                    <div>{item.title || 'Untitled Item'}</div>
                    {authors && 
                        <div className="display-flex flex-row items-center gap-1">
                            <div className="font-color-secondary truncate">{authors}</div>
                        </div>
                    }
                    {(publicationTitle || year) && (
                        <div className="font-color-secondary">
                            {publicationTitle && <i>{publicationTitle}</i>}
                            {publicationTitle && year && ', '}
                            {year}
                        </div>
                    )}
                    <ActionButtons item={item} />
                </div>
            </div>
        </div>
    );
};

export default ExternalReferenceListItem;