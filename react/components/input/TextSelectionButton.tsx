import React, { forwardRef } from 'react'
import { Icon, TextAlignLeftIcon, PdfIcon, FileViewIcon } from "../icons/icons"
import { useAtomValue, useSetAtom } from 'jotai'
import { effectiveReaderTextSelectionAtom, stagedReaderActionContextAtom } from '../../atoms/messageComposition'
import { openReader } from '../../runtime/navigation'
import { logger } from '@beaver/agent-core/platform/logger'
import { getCurrentReader, navigateToPageInCurrentReader } from '../../utils/readerUtils'
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu'
import { TextSelection } from '@beaver/agent-core/types/attachments/apiTypes'
import { truncateText } from '@beaver/agent-ui/utils/stringUtils'
import { ChipWithPopup, type ChipPopupContent } from '@beaver/agent-ui/chat/ChipPopup'
import { ChipButton } from '../agentRuns/requestChips/ChipButton'
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon'


const MAX_TEXT_SELECTION_TOOLTIP_TEXT_LENGTH = 160;

interface TextSelectionButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    selection: TextSelection
    canEdit?: boolean
    disabled?: boolean
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void
}

export const TextSelectionButton = forwardRef<HTMLButtonElement, TextSelectionButtonProps>(
    function TextSelectionButton(props: TextSelectionButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            selection,
            className,
            disabled = false,
            canEdit = true,
            onRemoveAll,
            onMouseEnter,
            onMouseLeave,
            onClick,
            ...rest
        } = props

        // States/Atoms needed for non-preview logic
        const setReaderTextSelection = useSetAtom(effectiveReaderTextSelectionAtom)

        // PDFs get the page-aware reveal label + navigation. EPUB and snapshot
        // reader types fall back to a generic file affordance with no page.
        const staged = useAtomValue(stagedReaderActionContextAtom);
        const readerType = staged ? staged.location?.contentKind : getCurrentReader()?.type;
        const revealSelection = () => {
            if (staged) {
                void openReader(staged.item.id, selection.page == null ? undefined : { pageIndex: selection.page - 1 })
                    .catch(error => logger(`TextSelectionButton: ${error}`, 2));
            } else if (selection.page != null) navigateToPageInCurrentReader(selection.page);
        };
        const isPdf = readerType === 'pdf';
        const readerTypeName = readerType === 'epub' ? 'EPUB'
            : readerType === 'snapshot' ? 'Snapshot'
            : 'Document';
        const revealIcon = isPdf ? PdfIcon : FileViewIcon;
        const revealLabel = isPdf
            ? (selection.page != null ? `Reveal page ${selection.page} in PDF` : 'Reveal in PDF')
            : `Reveal in ${readerTypeName}`;

        const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
            onRemove: () => {
                setReaderTextSelection(null) // Remove the selection itself
            },
            onRemoveAll,
            canEdit,
            disabled,
            // Mirror the button click: scroll the reader to the selection's page.
            extraMenuItems: [{
                label: revealLabel,
                icon: revealIcon,
                onClick: () => { revealSelection(); },
            }],
        })

        const popup = React.useMemo<ChipPopupContent>(() => {
            const selectionText = truncateText(selection.text.replace(/\s+/g, ' ').trim(), MAX_TEXT_SELECTION_TOOLTIP_TEXT_LENGTH);
            return {
                icon: <Icon icon={TextAlignLeftIcon} className="scale-90 font-color-primary mt-020" />,
                title: 'Text Selection',
                subtitle: selectionText ? { text: selectionText } : null,
                action: { icon: revealIcon, label: revealLabel },
            };
        }, [selection.text, revealIcon, revealLabel]);

        const normalIcon = (
            <Icon icon={TextAlignLeftIcon} className="mt-015 font-color-secondary" />
        );

        return (
            <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    ref={ref}
                    {...rest}
                    {...contextMenuHandlers}
                    className={`${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                    disabled={disabled}
                    onMouseEnter={onMouseEnter}
                    onMouseLeave={onMouseLeave}
                    onClick={(e) => {
                        e.stopPropagation();
                        revealSelection();
                        onClick?.(e);
                    }}
                >
                    {canEdit ? (
                        <ChipRemovableIcon
                            normalIcon={normalIcon}
                            removeHandlers={removeHandlers}
                            removeMenuOpen={isRemoveMenuOpen}
                        />
                    ) : normalIcon}
                    <span className={`truncate`}>
                        Text Selection
                    </span>
                </ChipButton>
            </ChipWithPopup>
            {removeMenu}
            </>
        )
    }
)
