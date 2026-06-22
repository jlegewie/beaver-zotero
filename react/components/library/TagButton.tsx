import React, { useState } from 'react';
import { useSetAtom } from 'jotai';
import { CSSIcon, TagIcon } from '../icons/icons';
import { removeTagIdAtom } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { ZoteroTag } from '../../types/zotero';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';

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

    // Filter the Zotero library by this tag using the tag selector. Tags have no
    // direct "select" mechanism like collections, so we switch to the tag's
    // library and apply it as a tag filter.
    const filterByTag = async () => {
        const zoteroPane = Zotero.getActiveZoteroPane();
        if (!zoteroPane) return;
        try {
            // Switch to the library tab so the filter is visible when the user is
            // currently viewing a reader or note tab.
            Zotero.getMainWindow()?.Zotero_Tabs?.select('zotero-pane');
            if (zoteroPane.collectionsView) {
                await zoteroPane.collectionsView.selectLibrary(tag.libraryId);
            }
            // Zotero tears down the tag selector (sets it to null) while its pane
            // is collapsed, so reveal it first. Otherwise the filter would never
            // be applied for users who keep the tag selector hidden.
            if (!zoteroPane.tagSelectorShown?.() && typeof zoteroPane.toggleTagSelector === 'function') {
                await zoteroPane.toggleTagSelector();
            }
            if (zoteroPane.tagSelector) {
                // Applying via the selector mirrors the selection in its UI and
                // triggers the items-view filter through its onSelection handler.
                zoteroPane.tagSelector.clearTagSelection();
                zoteroPane.tagSelector.handleTagSelected(tag.tag);
            } else if (zoteroPane.itemsView) {
                // Fallback if the selector still isn't available: filter the items
                // view directly so the action is never a silent no-op.
                await zoteroPane.itemsView.setFilter('tags', new Set([tag.tag]));
            }
        } catch {
            // Silently fail - tag filtering is a convenience feature
        }
    };

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
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                {...contextMenuHandlers}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={() => filterByTag()}
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

