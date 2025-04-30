// @ts-ignore no idea
import React, { useState, forwardRef, useRef, useEffect } from 'react'
import { CSSIcon, Icon, TextAlignLeftIcon } from "./icons"
import { useSetAtom, useAtom } from 'jotai'
import { readerTextSelectionAtom } from '../atoms/input'
import { TextSelection } from '../utils/readerUtils'
import { previewCloseTimeoutAtom, activePreviewAtom } from '../atoms/ui';


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
        const setActivePreview = useSetAtom(activePreviewAtom);
        const setReaderTextSelection = useSetAtom(readerTextSelectionAtom);
        const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);

        // Hover timer ref for triggering preview display
        const showPreviewTimerRef = useRef<number | null>(null);

        // Timer Utilities (copied from SourceButton for consistency)
        const cancelCloseTimer = () => {
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
                setPreviewCloseTimeout(null);
            }
        };

        const startCloseTimer = () => {
            cancelCloseTimer(); 
            const newTimeout = Zotero.getMainWindow().setTimeout(() => {
                setActivePreview(null);
                setPreviewCloseTimeout(null);
            }, 350); 
            setPreviewCloseTimeout(newTimeout);
        };
        
        const cancelShowPreviewTimer = () => {
             if (showPreviewTimerRef.current) {
                Zotero.getMainWindow().clearTimeout(showPreviewTimerRef.current);
                showPreviewTimerRef.current = null;
            }
        }

        const handleMouseEnter = () => {
            setIsHovered(true);
            cancelCloseTimer(); 
            cancelShowPreviewTimer(); 

            // Show preview after a short delay
            showPreviewTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
                // Make sure selection still exists when timer fires
                // (Could read readerTextSelectionAtom here, but passing selection prop is simpler)
                 setActivePreview({ type: 'textSelection', content: selection });
                 showPreviewTimerRef.current = null; 
            }, 100); // Short delay
        };

        const handleMouseLeave = () => {
            setIsHovered(false);
            cancelShowPreviewTimer(); 
            startCloseTimer(); 
        };

        // Cleanup timers on unmount
        useEffect(() => {
            return () => {
                cancelShowPreviewTimer();
            };
        }, []);

        // Removal handler
        const handleRemove = () => {
            cancelShowPreviewTimer(); // Prevent preview from showing if removed quickly
            cancelCloseTimer();       // Stop any pending close
            setActivePreview(null);   // Ensure preview is explicitly closed
            setReaderTextSelection(null); // Remove the selection itself
        }
        
        // Update getIconElement to use internal handleRemove
        const getIconElement = () => {
            if (isHovered && canEdit) {
                return (<span
                    role="button"
                    className="source-remove -ml-020 -mr-015"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove() // Use internal handleRemove
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
                    // _iframeWindow.PDFViewerApplication.pdfViewer.scrollPageIntoView({
                    // Maybe navigate to text in reader? Or just rely on preview action
                    // scrollPageIntoView({pageNumber: location.pageIndex + 1})
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