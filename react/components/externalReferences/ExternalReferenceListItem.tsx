import React, { useCallback } from 'react';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { useAtomValue } from 'jotai';
import { getHost } from '@beaver/agent-ui/host';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';
import { externalReferenceItemMappingAtom } from '@beaver/agent-core/citations/externalReferences';
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

    // A reference already in the library (found by the search, or imported
    // since) gets the item menu; one that is not has nothing to act on.
    const itemMapping = useAtomValue(externalReferenceItemMappingAtom);
    const libraryItem = (item.source_id && itemMapping[item.source_id]) || item.library_items[0];
    const { openItemMenu, itemMenu } = useItemContextMenu();

    return (
        <>
            <div
                className={`${baseClasses.join(' ')} ${className}`}
                onClick={handleClick}
                onContextMenu={libraryItem ? (event) => openItemMenu(libraryItem, event) : undefined}
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
                        {getHost().components?.externalReferenceActions({
                            item,
                            detailsButtonMode: 'icon-only',
                            webButtonMode: 'icon-only',
                            pdfButtonMode: 'icon-only',
                        })}
                    </div>
                </div>
            </div>
            {itemMenu}
        </>
    );
};

export default ExternalReferenceListItem;