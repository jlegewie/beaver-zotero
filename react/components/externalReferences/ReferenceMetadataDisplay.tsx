import React from 'react';
import { formatAuthors } from './utils';

interface ReferenceMetadataDisplayProps {
    /** Item title */
    title?: string;
    /** Array of author names */
    authors?: string[];
    /** Journal or venue name */
    publicationTitle?: string;
    /** Publication year */
    year?: string | number;
    /** 
     * Function to get text classes based on field type.
     * Returns appropriate classes for primary (title) or secondary (authors, publication) text.
     */
    getTextClasses?: (defaultClass?: string) => string;
}

/**
 * Shared component for displaying reference metadata (title, authors, publication, year).
 * Used by both CreateItemListItem and ExternalReferenceListItem.
 */
const ReferenceMetadataDisplay: React.FC<ReferenceMetadataDisplayProps> = ({
    title,
    authors,
    publicationTitle,
    year,
    getTextClasses = (defaultClass = 'font-color-primary') => defaultClass,
}) => {
    const formattedAuthors = formatAuthors(authors);

    return (
        <div className="display-flex flex-col gap-1">
            <div className={getTextClasses()}>
                {title || 'Untitled Item'}
            </div>
            {formattedAuthors && (
                <div className={`${getTextClasses('font-color-secondary')} truncate`}>
                    {formattedAuthors}
                </div>
            )}
            {(publicationTitle || year) && (
                <div className={getTextClasses('font-color-secondary')}>
                    {publicationTitle && <i>{publicationTitle}</i>}
                    {publicationTitle && year && ', '}
                    {year}
                </div>
            )}
        </div>
    );
};

export default ReferenceMetadataDisplay;

