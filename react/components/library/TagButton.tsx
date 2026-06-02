import React, { useState } from 'react';
import { useSetAtom } from 'jotai';
import { CSSIcon } from '../icons/icons';
import { removeTagIdAtom } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { ZoteroTag } from '../../types/zotero';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';

const MAX_TAGBUTTON_TEXT_LENGTH = 20;

interface TagButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    tag: ZoteroTag;
    canEdit?: boolean;
    disabled?: boolean;
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void;
}

export const TagButton: React.FC<TagButtonProps> = ({
    tag,
    className,
    disabled = false,
    canEdit = true,
    onRemoveAll,
    ...rest
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const removeTagId = useSetAtom(removeTagIdAtom);

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => removeTagId(tag.id),
        onRemoveAll,
        canEdit,
        disabled,
    });

    const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        // Tags don't have a direct selection mechanism in Zotero like collections
        // So we don't navigate anywhere on click
    };

    const getIconElement = () => {
        if ((isHovered || isRemoveMenuOpen) && canEdit) {
            return (
                <span role="button" className="source-remove" {...removeHandlers}>
                    <CSSIcon name="x-8" className="icon-16" />
                </span>
            );
        }

        return <CSSIcon
            name="tag"
            className="icon-16 scale-80"
            style={{
                color: tag.color,
            }}
        />;
    };

    const getButtonClasses = () => {
        const baseClasses = `variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
        return baseClasses;
    };

    const getTooltipTitle = () => {
        return "Search is restricted to the selected tags";
    };

    const displayName = truncateText(tag.tag, MAX_TAGBUTTON_TEXT_LENGTH);

    return (
        <>
        <button
            style={{ height: '22px' }}
            title={getTooltipTitle()}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            {...contextMenuHandlers}
            className={getButtonClasses()}
            disabled={disabled}
            onClick={handleButtonClick}
            {...rest}
        >
            {getIconElement()}
            <span className="truncate">
                {displayName}
            </span>
            <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
        </button>
        {removeMenu}
        </>
    );
};

