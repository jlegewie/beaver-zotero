import React from 'react';
import { useAtom } from 'jotai';
import { CSSIcon, LibraryIcon } from '../icons/icons';
import { currentMessageViewsAtom } from '../../atoms/messageComposition';
import { messageAttachmentKey, type ViewAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { getHost } from '@beaver/agent-ui/host';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { ChipWithPopup, type ChipPopupContent } from '@beaver/agent-ui/chat/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon';
import { viewChipDisplay } from '../agentRuns/requestChips/RequestChipPrimitives';

const MAX_TEXT_LENGTH = 20;

interface MessageViewButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    view: ViewAttachment;
    disabled?: boolean;
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void;
}

/** Composer chip for an attached saved search or built-in view (Unfiled Items, …). */
export const MessageViewButton: React.FC<MessageViewButtonProps> = ({
    view,
    className,
    disabled = false,
    onRemoveAll,
    ...rest
}) => {
    const [views, setViews] = useAtom(currentMessageViewsAtom);
    const revealView = () => void getHost().navigation?.revealView?.(view);

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => {
            const removedKey = messageAttachmentKey(view);
            setViews(views.filter(v => messageAttachmentKey(v) !== removedKey));
        },
        onRemoveAll,
        canEdit: true,
        disabled,
        extraMenuItems: [{
            label: 'Reveal in Library',
            icon: LibraryIcon,
            onClick: revealView,
        }],
    });

    const { iconName, kindLabel } = viewChipDisplay(view);
    const icon = (
        <span className="scale-90">
            <CSSIcon name={iconName} className="icon-16" />
        </span>
    );

    const popup: ChipPopupContent = {
        icon,
        title: view.name,
        subtitle: { text: kindLabel },
        action: { icon: LibraryIcon, label: 'Reveal in library' },
    };

    return (
        <>
        <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
            <ChipButton
                {...contextMenuHandlers}
                className={`${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                disabled={disabled}
                onClick={revealView}
                {...rest}
            >
                {!disabled ? (
                    <ChipRemovableIcon
                        normalIcon={icon}
                        removeHandlers={removeHandlers}
                        removeMenuOpen={isRemoveMenuOpen}
                    />
                ) : icon}
                <span className="truncate">
                    {truncateText(view.name, MAX_TEXT_LENGTH)}
                </span>
            </ChipButton>
        </ChipWithPopup>
        {removeMenu}
        </>
    );
};
