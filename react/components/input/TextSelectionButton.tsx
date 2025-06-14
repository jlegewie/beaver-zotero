import React, { forwardRef } from 'react'
import { CSSIcon, Icon, TextAlignLeftIcon } from "../icons/icons"
import { useSetAtom } from 'jotai'
import { readerTextSelectionAtom } from '../../atoms/input'
import { navigateToPageInCurrentReader } from '../../utils/readerUtils'
import { usePreviewHover } from '../../hooks/usePreviewHover'
import { activePreviewAtom } from '../../atoms/ui'
import { TextSelection } from '../../types/attachments/apiTypes'


interface TextSelectionButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    selection: TextSelection
    canEdit?: boolean
    disabled?: boolean
}

export const TextSelectionButton = forwardRef<HTMLButtonElement, TextSelectionButtonProps>(
    function TextSelectionButton(props: TextSelectionButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            selection,
            className,
            disabled = false,
            canEdit = true,
            ...rest
        } = props

        // States/Atoms needed for non-preview logic
        const setActivePreview = useSetAtom(activePreviewAtom)
        const setReaderTextSelection = useSetAtom(readerTextSelectionAtom)

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            { type: 'textSelection', content: selection }, // Preview content
            { isEnabled: !disabled && canEdit } // Options: Disable if button disabled or not editable
        )

        // Update handleRemove to use cancelTimers from the hook
        const handleRemove = () => {
            cancelTimers() // Cancel preview timers
            setActivePreview(null) // Ensure preview is explicitly closed
            setReaderTextSelection(null) // Remove the selection itself
        }

        // Update getIconElement to use isHovered from the hook
        const getIconElement = () => {
            // Use isHovered from the hook
            if (isHovered && canEdit) {
                return (<span
                    role="button"
                    className="source-remove -ml-020 -mr-015"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove()
                    }}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>)
            }
            return (
                <Icon icon={TextAlignLeftIcon} className="mt-015 font-color-secondary"/>
            )
        }

        return (
            <button
                ref={ref}
                // Spread the event handlers from the hook
                {...hoverEventHandlers}
                className={
                    `variant-outline source-button
                    ${className || ''}
                    ${disabled ? 'disabled-but-styled' : ''}
                `}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation();
                    navigateToPageInCurrentReader(selection.page);
                }}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate`}>
                    Text Selection
                </span>
            </button>
        )
    }
)