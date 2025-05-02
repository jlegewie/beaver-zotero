import React, { forwardRef } from 'react'
import { CSSIcon, Icon } from "./icons"
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { useSetAtom } from 'jotai'
import { activePreviewAtom } from '../atoms/ui'
import { usePreviewHover } from '../hooks/usePreviewHover'
import { readerAnnotationsAtom } from '../atoms/input';
import { Annotation } from '../types/attachments/apiTypes';

const ANNOTATION_TEXT_BY_TYPE = {
    highlight: 'Highlight',
    underline: 'Underline',
    note: 'Note',
    image: 'Image',
}

const ANNOTATION_ICON_BY_TYPE = {
    highlight: ZOTERO_ICONS.ANNOTATE_HIGHLIGHT,
    underline: ZOTERO_ICONS.ANNOTATE_UNDERLINE,
    note: ZOTERO_ICONS.ANNOTATE_NOTE,
    text: ZOTERO_ICONS.ANNOTATE_TEXT,
    image: ZOTERO_ICONS.ANNOTATE_AREA,
}

interface AnnotationButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'content'> {
    annotation: Annotation
    canEdit?: boolean
    disabled?: boolean
    onRemove?: (annotationKey: string) => void; // Optional callback for removal
}

export const AnnotationButton = forwardRef<HTMLButtonElement, AnnotationButtonProps>(
    function AnnotationButton(props: AnnotationButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            annotation,
            className,
            disabled = false,
            canEdit = true,
            ...rest
        } = props

        // States/Atoms needed for non-preview logic
        const setActivePreview = useSetAtom(activePreviewAtom)
        const setReaderAnnotationsAtom = useSetAtom(readerAnnotationsAtom);

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            { type: 'annotation', content: annotation }, // Preview content for annotation
            { isEnabled: !disabled && canEdit } // Options: Disable if button disabled or not editable
        )

        // Handle removal: Use the provided callback if available
        const handleRemove = () => {
            cancelTimers() // Cancel preview timers
            setActivePreview(null) // Ensure preview is explicitly closed
            setReaderAnnotationsAtom((prev) => prev.filter((a) => a.zotero_key !== annotation.zotero_key))
        }

        // Update getIconElement to use isHovered from the hook
        const getIconElement = () => {
            // Use isHovered from the hook
            if (isHovered && canEdit) {
                return (<span
                    role="button"
                    className="source-remove -ml-015"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove() // Use internal handleRemove
                    }}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>)
            }
            // Use Zotero annotation icons
            return (
                <ZoteroIcon icon={ANNOTATION_ICON_BY_TYPE[annotation.annotation_type]} size={14}/>
            )
        }

        // Determine display text
        const displayText = ANNOTATION_TEXT_BY_TYPE[annotation.annotation_type] || 'Annotation';

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
                    // TODO: Implement navigation to annotation using `navigateToAnnotation`
                }}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate`}>
                    {displayText}
                </span>
            </button>
        )
    }
) 