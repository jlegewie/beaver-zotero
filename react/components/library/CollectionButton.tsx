import React, { useState } from 'react';
import { useSetAtom } from 'jotai';
import { CSSIcon, LibraryIcon } from '../icons/icons';
import { removeCollectionIdAtom } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { selectCollection } from '../../../src/utils/selectItem';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';

const MAX_COLLECTIONBUTTON_TEXT_LENGTH = 20;

interface CollectionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    collection: Zotero.Collection;
    canEdit?: boolean;
    disabled?: boolean;
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void;
}

export const CollectionButton: React.FC<CollectionButtonProps> = ({
    collection,
    className,
    disabled = false,
    canEdit = true,
    onRemoveAll,
    ...rest
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const removeCollectionId = useSetAtom(removeCollectionIdAtom);

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => removeCollectionId(collection.id),
        onRemoveAll,
        canEdit,
        disabled,
        // Mirror the button click: select (reveal) the collection in the library.
        extraMenuItems: [{
            label: 'Reveal Collection',
            icon: LibraryIcon,
            onClick: () => selectCollection(collection),
        }],
    });

    const getIconElement = () => {
        if ((isHovered || isRemoveMenuOpen) && canEdit) {
            return (
                <span role="button" className="source-remove" {...removeHandlers}>
                    <CSSIcon name="x-8" className="icon-16" />
                </span>
            );
        }

        return (
            <span className="scale-90">
                <CSSIcon name="collection" className="icon-16" />
            </span>
        );
    };

    const getButtonClasses = () => {
        return `${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
    };

    const displayName = truncateText(collection.name, MAX_COLLECTIONBUTTON_TEXT_LENGTH);

    const popup: ChipPopupContent = {
        icon: (
            <span className="scale-90">
                <CSSIcon name="collection" className="icon-16" />
            </span>
        ),
        title: collection.name,
        subtitle: { text: 'Search filter' },
        action: { icon: LibraryIcon, label: 'Reveal in library' },
    };

    return (
        <>
        <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
            <ChipButton
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                {...contextMenuHandlers}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={() => selectCollection(collection)}
                {...rest}
            >
                {getIconElement()}
                <span className="truncate">
                    {displayName}
                </span>
                <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
            </ChipButton>
        </ChipWithPopup>
        {removeMenu}
        </>
    );
};
