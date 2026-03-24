import React, { useState } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { CSSIcon } from '../icons/icons';
import { currentMessageCollectionsAtom, CollectionReference } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { selectCollection } from '../../../src/utils/selectItem';

const MAX_TEXT_LENGTH = 20;

interface MessageCollectionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    collection: CollectionReference;
    canEdit?: boolean;
    disabled?: boolean;
}

export const MessageCollectionButton: React.FC<MessageCollectionButtonProps> = ({
    collection,
    className,
    disabled = false,
    canEdit = true,
    ...rest
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const setCollections = useSetAtom(currentMessageCollectionsAtom);
    const collections = useAtomValue(currentMessageCollectionsAtom);

    const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        setCollections(collections.filter(c => c.key !== collection.key || c.libraryID !== collection.libraryID));
    };

    const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (!disabled) {
            try {
                const col = Zotero.Collections.getByLibraryAndKey(collection.libraryID, collection.key);
                if (col) selectCollection(col);
            } catch { /* ignore */ }
        }
    };

    const getIconElement = () => {
        if (isHovered && canEdit && !disabled) {
            return (
                <span role="button" className="source-remove" onClick={handleRemove}>
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
        <button
            style={{ height: '22px' }}
            title={collection.name}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
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
    );
};
