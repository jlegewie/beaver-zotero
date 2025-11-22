import React, { useCallback } from 'react';
import { ExternalReference } from '../../types/externalReferences';
import {
    ArrowUpRightIcon,
    DownloadIcon,
} from '../icons/icons';
import Button from '../ui/Button';
import { ExternalReferenceResult } from '../../types/chat/apiTypes';
import { formatAuthors } from './utils';

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
    const publicationTitle = item.publication_title || item.venue;
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
                    <div className="display-flex flex-row items-center gap-3">
                        <Button
                            variant="surface-light"
                            // icon={ArrowUpRightIcon}
                            className="font-color-secondary truncate"
                            onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                            disabled={!item.abstract}
                            style={{ padding: '1px 4px' }}
                        >
                            Abstract
                        </Button>
                                                <Button
                            variant="surface-light"
                            icon={ArrowUpRightIcon}
                            className="font-color-secondary truncate"
                            onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                            disabled={!item.publication_url && !item.url}
                            style={{ padding: '1px 4px' }}
                        >
                            Website
                        </Button>                        
                        <Button
                            variant="surface-light"
                            icon={DownloadIcon}
                            className="font-color-secondary truncate"
                            onClick={() => (item.publication_url || item.url) ? Zotero.launchURL(item.publication_url || item.url!) : undefined}
                            disabled={!item.publication_url && !item.url}
                            style={{ padding: '1px 4px' }}
                        >
                            Import
                        </Button>
                        <div className="font-color-tertiary">Cited by {(item.citation_count || 0).toLocaleString()}</div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ExternalReferenceListItem;