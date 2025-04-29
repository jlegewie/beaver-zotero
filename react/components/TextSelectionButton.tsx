// @ts-ignore no idea
import React, { useState, forwardRef, useRef } from 'react'
import { CSSIcon, Icon } from "./icons"
import { useSetAtom, useAtomValue } from 'jotai'
import { readerItemKeyAtom, removeSourceAtom } from '../atoms/input'
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
        const removeSource = useSetAtom(removeSourceAtom);
        const setPreviewedSource = useSetAtom(previewedSourceAtom);
        const readerItemKey = useAtomValue(readerItemKeyAtom);
        // const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
        
        // Hover timer ref for handling delayed hover behavior
        const hoverTimerRef = useRef<number | null>(null);

        const getIconElement = () => {
            if (isHovered && canEdit) {
                return (<span
                    role="button"
                    className="source-remove"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove()
                    }}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>)
            }
            return (
                <span className="font-color-secondary mt-015">
                    <Icon icon={TextAlignLeftIcon} />
                </span>
            )
        }

        const handleRemove = () => {
            // removeSource(source)
        }

        return (
            <button
                ref={ref}
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