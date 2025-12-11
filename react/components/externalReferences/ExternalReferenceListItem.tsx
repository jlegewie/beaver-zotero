import React, { useCallback } from 'react';
import { ExternalReference } from '../../types/externalReferences';
import ActionButtons from './actionButtons';
import ReferenceMetadataDisplay from './ReferenceMetadataDisplay';

interface ExternalReferenceItemPListrops {
    item: ExternalReference;
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
                <div className="display-flex flex-col flex-1 gap-2 min-w-0 font-color-primary">
                    <ReferenceMetadataDisplay
                        title={item.title}
                        authors={item.authors}
                        publicationTitle={item.journal?.name || item.venue}
                        year={item.year}
                    />
                    <ActionButtons
                        item={item}
                        detailsButtonMode="icon-only"
                        webButtonMode="icon-only"
                        pdfButtonMode="icon-only"
                        // revealButtonMode="icon-only"
                        // importButtonMode="icon-only"
                    />
                </div>
            </div>
        </div>
    );
};

export default ExternalReferenceListItem;