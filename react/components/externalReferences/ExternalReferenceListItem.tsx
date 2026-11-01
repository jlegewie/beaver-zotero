import React from 'react';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { useAtomValue } from 'jotai';
import { getHost } from '@beaver/agent-ui/host';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';
import { externalReferenceItemMappingAtom } from '@beaver/agent-core/citations/externalReferences';
import { primaryExternalUrl } from '@beaver/agent-core/citations/externalRecordDisplay';
import ReferenceMetadataDisplay from './ReferenceMetadataDisplay';
import { RetractedBanner } from './ExternalRecordParts';

interface ReferenceRowFrameProps {
    item: ExternalReference;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
    children: React.ReactNode;
}

/**
 * The frame every result row shares: hover state, and the item menu once the
 * reference is in the library (found by the search, or imported since).
 */
export const ReferenceRowFrame: React.FC<ReferenceRowFrameProps> = ({
    item,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className = '',
    children,
}) => {
    const itemMapping = useAtomValue(externalReferenceItemMappingAtom);
    const libraryItem = (item.source_id && itemMapping[item.source_id]) || item.library_items?.[0];
    const { openItemMenu, itemMenu } = useItemContextMenu();

    return (
        <>
            <div
                className={`px-3 py-2 display-flex flex-col gap-1 rounded-sm transition user-select-none ${isHovered ? 'bg-quinary' : ''} ${className}`}
                onContextMenu={libraryItem ? (event) => openItemMenu(libraryItem, event) : undefined}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
            >
                <div className="display-flex flex-col flex-1 gap-2 min-w-0 font-color-primary">
                    {children}
                </div>
            </div>
            {itemMenu}
        </>
    );
};

interface ExternalReferenceListItemProps {
    item: ExternalReference;
    /** Source of the results view the row is in; selects the primary link. */
    viewSource?: string | null;
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className?: string;
}

/** The generic result card, used for every source without its own presentation. */
const ExternalReferenceListItem: React.FC<ExternalReferenceListItemProps> = ({
    item,
    viewSource,
    isHovered,
    onMouseEnter,
    onMouseLeave,
    className,
}) => (
    <ReferenceRowFrame
        item={item}
        isHovered={isHovered}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className={className}
    >
        {item.is_retracted && <RetractedBanner />}
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
            webUrl: primaryExternalUrl(item, viewSource),
        })}
    </ReferenceRowFrame>
);

export default ExternalReferenceListItem;
