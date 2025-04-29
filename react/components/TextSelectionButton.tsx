// @ts-ignore no idea
import React, { useState, forwardRef, useRef } from 'react'
import { CSSIcon, Icon } from "./icons"
import { useSetAtom, useAtom } from 'jotai'
import { readerTextSelectionAtom } from '../atoms/input'
import { previewTextSelectionAtom } from '../atoms/ui'
import { TextAlignLeftIcon } from './icons'
import { TextSelection } from '../utils/readerUtils'
import { previewCloseTimeoutAtom } from '../atoms/ui';


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
        const setPreviewTextSelection = useSetAtom(previewTextSelectionAtom);
        const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
        const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);

        // Hover timer ref for handling delayed hover behavior
        const hoverTimerRef = useRef<number | null>(null);

        // Start a timeout to close the preview after delay
        const startCloseTimer = () => {
            // Clear any existing timeout
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
            }
            
            // Start a new timeout
            const newTimeout = Zotero.getMainWindow().setTimeout(() => {
                setPreviewTextSelection(false);
                setPreviewCloseTimeout(null);
            }, 350); // 300ms delay before closing
            
            setPreviewCloseTimeout(newTimeout);
        };

        const cancelCloseTimer = () => {
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
                setPreviewCloseTimeout(null);
            }
        };

        const handleMouseEnter = () => {
            setIsHovered(true);
            cancelCloseTimer();
            
            // Show preview with a small delay to prevent flashing during quick mouse movements
            if (hoverTimerRef.current) {
                Zotero.getMainWindow().clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            
            hoverTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
                setPreviewTextSelection(true);
            }, 100); // Shorter delay of 100ms before showing preview
        };

        const handleMouseLeave = () => {
            setIsHovered(false);
            
            // Clear any pending show timers
            if (hoverTimerRef.current) {
                Zotero.getMainWindow().clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            
            // Start the close timer when mouse leaves button
            // This will be canceled if mouse enters preview quickly enough
            startCloseTimer();
        };
        
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
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
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