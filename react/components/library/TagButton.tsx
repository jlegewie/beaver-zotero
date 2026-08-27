import React from 'react';
import { useSetAtom } from 'jotai';
import { CSSIcon, TagIcon } from '../icons/icons';
import { removeTagIdAtom } from '../../atoms/messageComposition';
import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { ZoteroTag } from '@beaver/agent-core/types/zotero';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { ChipWithPopup, type ChipPopupContent } from '@beaver/agent-ui/chat/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon';
import { selectTagFilter } from '../../../src/utils/selectItem';

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
    const removeTagId = useSetAtom(removeTagIdAtom);

    const filterByTag = () => selectTagFilter(tag.tag, tag.libraryId);

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => removeTagId(tag.id),
        onRemoveAll,
        canEdit,
        disabled,
        extraMenuItems: [{
            label: 'Filter Library by Tag',
            icon: TagIcon,
            onClick: filterByTag,
        }],
    });

    const normalIcon = (
        <CSSIcon
            name="tag"
            className="icon-16 scale-80"
            style={{
                color: tag.color,
            }}
        />
    );

    const getButtonClasses = () => {
        return `${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
    };

    const displayName = truncateText(tag.tag, MAX_TAGBUTTON_TEXT_LENGTH);

    const popup: ChipPopupContent = {
        icon: (
            <CSSIcon
                name="tag"
                className="icon-16 scale-80"
                style={tag.color ? { color: tag.color } : undefined}
            />
        ),
        title: tag.tag,
        subtitle: { text: 'Search filter' },
        action: { icon: TagIcon, label: 'Filter library by tag' },
    };

    return (
        <>
        <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
            <ChipButton
                {...contextMenuHandlers}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={() => filterByTag()}
                {...rest}
            >
                {canEdit ? (
                    <ChipRemovableIcon
                        normalIcon={normalIcon}
                        removeHandlers={removeHandlers}
                        removeMenuOpen={isRemoveMenuOpen}
                    />
                ) : normalIcon}
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

