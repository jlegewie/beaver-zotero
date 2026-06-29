import React, { forwardRef } from 'react'
import { Icon, TextAlignLeftIcon, PdfIcon, FileViewIcon } from "../icons/icons"
import { useSetAtom } from 'jotai'
import { readerTextSelectionAtom } from '../../atoms/messageComposition'
import { getCurrentReader, navigateToPageInCurrentReader } from '../../utils/readerUtils'
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu'
import { TextSelection } from '../../types/attachments/apiTypes'
import { truncateText } from '../../utils/stringUtils'
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup'
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
        const setReaderTextSelection = useSetAtom(readerTextSelectionAtom)

        // PDFs get the page-aware reveal label + navigation. EPUB and snapshot
        // reader types fall back to a generic file affordance with no page.
        const readerType = getCurrentReader()?.type;
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
                onClick: () => { if (selection.page != null) navigateToPageInCurrentReader(selection.page); },
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
                        if (selection.page != null) navigateToPageInCurrentReader(selection.page);
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
