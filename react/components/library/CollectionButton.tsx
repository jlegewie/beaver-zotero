import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { CSSIcon } from '../icons/icons';
import { currentMessageFiltersAtom, removeCollectionIdAtom } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { selectCollection } from '../../../src/utils/selectItem';

const MAX_COLLECTIONBUTTON_TEXT_LENGTH = 20;

interface CollectionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    collection: Zotero.Collection;
    canEdit?: boolean;
    disabled?: boolean;
}

export const CollectionButton: React.FC<CollectionButtonProps> = ({
    collection,
    className,
    disabled = false,
    canEdit = true,
    ...rest
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const removeCollectionId = useSetAtom(removeCollectionIdAtom);
    const { collectionIds } = useAtomValue(currentMessageFiltersAtom);
    const isValid = collectionIds.includes(collection.id);

    const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        removeCollectionId(collection.id);
    };

    const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (!disabled) {
            selectCollection(collection);
        }
    };

    const getIconElement = () => {
        if (isHovered && canEdit) {
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

    const getButtonClasses = () => {
        const baseClasses = `variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
        if (!isValid) {
            return `${baseClasses} border-red`;
        }
        return baseClasses;
    };

    const getTooltipTitle = () => {
        return "Search is restricted to the selected collections";
    };

    const displayName = truncateText(collection.name, MAX_COLLECTIONBUTTON_TEXT_LENGTH);

    return (
        <button
            style={{ height: '22px' }}
            title={getTooltipTitle()}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            className={getButtonClasses()}
            disabled={disabled}
            onClick={handleButtonClick}
            {...rest}
        >
            {getIconElement()}
            <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                {displayName}
            </span>
            <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
        </button>
    );
};
