// @ts-ignore no idea
import React, { useState, forwardRef, useRef } from 'react'
import { CSSIcon, Icon } from "./icons"
import { useSetAtom, useAtomValue } from 'jotai'
import { readerItemKeyAtom, readerTextSelectionAtom, removeSourceAtom } from '../atoms/input'
import { previewedSourceAtom } from '../atoms/ui'
import { TextAlignLeftIcon } from './icons'
import { TextSelection } from '../utils/readerUtils'


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
        // States
        const [isHovered, setIsHovered] = useState(false);
        const setPreviewedSource = useSetAtom(previewedSourceAtom);
        const readerItemKey = useAtomValue(readerItemKeyAtom);
        const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
        // const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
        
        // Hover timer ref for handling delayed hover behavior
        const hoverTimerRef = useRef<number | null>(null);

        const getIconElement = () => {
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

        const handleRemove = () => {
            setReaderTextSelection(null);
        }

        return (
            <button
                ref={ref}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                className={
                    `variant-outline source-button
                    ${className || ''}
                    ${disabled ? 'disabled-but-styled' : ''}
                `}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation();
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