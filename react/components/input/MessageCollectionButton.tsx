import React from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { CSSIcon, LibraryIcon } from '../icons/icons';
import { currentMessageCollectionsAtom } from '../../atoms/messageComposition';
import { CollectionReference, collectionReferenceKey } from '../../types/zotero';
import { truncateText } from '../../utils/stringUtils';
import { selectCollection } from '../../../src/utils/selectItem';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon';

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
            label: 'Reveal Collection',
            icon: LibraryIcon,
            onClick: revealCollection,
        }],
    });

    const normalIcon = (
        <span className="scale-90">
            <CSSIcon name="collection" className="icon-16" />
        </span>
    );

    const popup: ChipPopupContent = {
        icon: (
            <span className="scale-90">
                <CSSIcon name="collection" className="icon-16" />
            </span>
        ),
        title: collection.name,
        subtitle: { text: 'Collection' },
        action: { icon: LibraryIcon, label: 'Reveal in library' },
    };

    return (
        <>
        <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
            <ChipButton
                {...contextMenuHandlers}
                className={`${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                disabled={disabled}
                onClick={() => revealCollection()}
                {...rest}
            >
                {canEdit && !disabled ? (
                    <ChipRemovableIcon
                        normalIcon={normalIcon}
                        removeHandlers={removeHandlers}
                        removeMenuOpen={isRemoveMenuOpen}
                    />
                ) : normalIcon}
                <span className="truncate">
                    {truncateText(collection.name, MAX_TEXT_LENGTH)}
                </span>
            </ChipButton>
        </ChipWithPopup>
        {removeMenu}
        </>
    );
};
