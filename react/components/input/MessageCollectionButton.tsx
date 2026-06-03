import React, { useState } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { CSSIcon, LibraryIcon } from '../icons/icons';
import { currentMessageCollectionsAtom } from '../../atoms/messageComposition';
import { CollectionReference, collectionReferenceKey } from '../../types/zotero';
import { truncateText } from '../../utils/stringUtils';
import { selectCollection } from '../../../src/utils/selectItem';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';

const MAX_TEXT_LENGTH = 20;

interface MessageCollectionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    collection: CollectionReference;
    canEdit?: boolean;
    disabled?: boolean;
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void;
}

export const MessageCollectionButton: React.FC<MessageCollectionButtonProps> = ({
    collection,
    className,
    disabled = false,
    canEdit = true,
    onRemoveAll,
    ...rest
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const setCollections = useSetAtom(currentMessageCollectionsAtom);
    const collections = useAtomValue(currentMessageCollectionsAtom);

    // Select (reveal) the referenced collection in the library. Shared by the
    // button click and the "Show in Library" context-menu entry.
    const revealCollection = () => {
        try {
            const col = Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key);
            if (col) selectCollection(col);
        } catch { /* ignore */ }
    };

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => {
            const removedKey = collectionReferenceKey(collection);
            setCollections(collections.filter(c => collectionReferenceKey(c) !== removedKey));
        },
        onRemoveAll,
        canEdit,
        disabled,
        extraMenuItems: [{
            label: 'Show in Library',
            icon: LibraryIcon,
            onClick: revealCollection,
        }],
    });

    const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (!disabled) {
            revealCollection();
        }
    };

    const getIconElement = () => {
        if ((isHovered || isRemoveMenuOpen) && canEdit && !disabled) {
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

    return (
        <>
        <button
            style={{ height: '22px' }}
            title={collection.name}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            {...contextMenuHandlers}
            className={`variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
            disabled={disabled}
            onClick={handleButtonClick}
            {...rest}
        >
            {getIconElement()}
            <span className="truncate">
                {truncateText(collection.name, MAX_TEXT_LENGTH)}
            </span>
        </button>
        {removeMenu}
        </>
    );
};
