import React, { forwardRef } from 'react'
import { CSSIcon, Icon, TextAlignLeftIcon, PdfIcon } from "../icons/icons"
import { useSetAtom } from 'jotai'
import { readerTextSelectionAtom } from '../../atoms/messageComposition'
import { navigateToPageInCurrentReader } from '../../utils/readerUtils'
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu'
import { TextSelection } from '../../types/attachments/apiTypes'
import { truncateText } from '../../utils/stringUtils'
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup'
import { ChipButton } from '../agentRuns/requestChips/ChipButton'


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
        const [isHovered, setIsHovered] = React.useState(false);

        const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
            onRemove: () => {
                setReaderTextSelection(null) // Remove the selection itself
            },
            onRemoveAll,
            canEdit,
            disabled,
            // Mirror the button click: scroll the reader to the selection's page.
            extraMenuItems: [{
                label: 'Reveal in PDF',
                icon: PdfIcon,
                onClick: () => { if (selection.page != null) navigateToPageInCurrentReader(selection.page); },
            }],
        })

        const popup = React.useMemo<ChipPopupContent>(() => {
            const selectionText = truncateText(selection.text.replace(/\s+/g, ' ').trim(), MAX_TEXT_SELECTION_TOOLTIP_TEXT_LENGTH);
            return {
                icon: <Icon icon={TextAlignLeftIcon} className="scale-90 font-color-primary" />,
                title: 'Text Selection',
                subtitle: selectionText ? { text: selectionText } : null,
                action: { icon: PdfIcon, label: selection.page != null ? `Reveal page ${selection.page} in PDF` : 'Reveal in PDF' },
            };
        }, [selection.page, selection.text]);

        const getIconElement = () => {
            if ((isHovered || isRemoveMenuOpen) && canEdit) {
                return (<span
                    role="button"
                    className="source-remove -ml-020 -mr-015"
                    {...removeHandlers}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>)
            }
            return (
                <Icon icon={TextAlignLeftIcon} className="mt-015 font-color-secondary"/>
            )
        }

        return (
            <>
            <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
                <ChipButton
                    ref={ref}
                    {...rest}
                    {...contextMenuHandlers}
                    className={`${className || ''} ${disabled ? 'disabled-but-styled' : ''}`}
                    disabled={disabled}
                    onMouseEnter={(event) => {
                        setIsHovered(true);
                        onMouseEnter?.(event);
                    }}
                    onMouseLeave={(event) => {
                        setIsHovered(false);
                        onMouseLeave?.(event);
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (selection.page != null) navigateToPageInCurrentReader(selection.page);
                        onClick?.(e);
                    }}
                >
                    {getIconElement()}
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
