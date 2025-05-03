import React, { forwardRef, useEffect, useState } from 'react'
import { CSSIcon, Icon, ArrowUpRightIcon } from "./icons"
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { useSetAtom, useAtomValue } from 'jotai'
import { ActivePreview, activePreviewAtom } from '../atoms/ui'
import { usePreviewHover } from '../hooks/usePreviewHover'
import { currentReaderAttachmentKeyAtom, readerAnnotationsAtom } from '../atoms/input';
import { Annotation } from '../types/attachments/apiTypes';
import { navigateToPage } from '../utils/readerUtils';
import { InputSource } from '../types/sources';
import { toAnnotation } from '../types/attachments/converters';
import { getZoteroItem } from '../utils/sourceUtils';

export const ANNOTATION_TEXT_BY_TYPE = {
    highlight: 'Highlight',
    underline: 'Underline',
    note: 'Note',
    image: 'Area',
}

export const ANNOTATION_ICON_BY_TYPE = {
    highlight: ZOTERO_ICONS.ANNOTATE_HIGHLIGHT,
    underline: ZOTERO_ICONS.ANNOTATE_UNDERLINE,
    note: ZOTERO_ICONS.ANNOTATE_NOTE,
    text: ZOTERO_ICONS.ANNOTATE_TEXT,
    image: ZOTERO_ICONS.ANNOTATE_AREA,
}

interface AnnotationButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'content'> {
    annotation?: Annotation
    source?: InputSource
    canEdit?: boolean
    disabled?: boolean
    onRemove?: (annotationKey: string) => void; // Optional callback for removal
}

export const AnnotationButton = forwardRef<HTMLButtonElement, AnnotationButtonProps>(
    function AnnotationButton(props: AnnotationButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            annotation: annotationProp,
            source,
            className,
            disabled = false,
            canEdit = true,
            ...rest
        } = props
        
        const setActivePreview = useSetAtom(activePreviewAtom)
        const setReaderAnnotationsAtom = useSetAtom(readerAnnotationsAtom);
        const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);
        const [derivedAnnotation, setDerivedAnnotation] = useState<Annotation | null>(null);

        // Define preview content
        const previewContent = derivedAnnotation 
            ? { type: 'annotation', content: derivedAnnotation } as ActivePreview
            : null;

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            previewContent,
            // Options: Disable if derivedAnnotation undefined orbutton disabled or not editable
            { isEnabled: !disabled && canEdit && !!derivedAnnotation }
        )

        useEffect(() => {
            // When annotation prop is provided directly, use it
            if (annotationProp) {
                setDerivedAnnotation(annotationProp);
                return;
            }
            
            // Otherwise try to derive from source
            if (source) {
                const item = getZoteroItem(source);
                if (item) {
                    setDerivedAnnotation(toAnnotation(item));
                } else {
                    setDerivedAnnotation(null);
                }
            } else {
                setDerivedAnnotation(null);
            }
        }, [annotationProp, source]);

        // Early return if no annotation is available
        if (!derivedAnnotation) return null;

        // Handle removal: Use the provided callback if available
        const handleRemove = () => {
            cancelTimers() // Cancel preview timers
            setActivePreview(null) // Ensure preview is explicitly closed
            setReaderAnnotationsAtom((prev) => prev.filter((a) => a.zotero_key !== derivedAnnotation.zotero_key))
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
                <ZoteroIcon icon={ANNOTATION_ICON_BY_TYPE[derivedAnnotation.annotation_type]} size={14}/>
            )
        }

        // Determine display text
        const displayText = ANNOTATION_TEXT_BY_TYPE[derivedAnnotation.annotation_type] || 'Annotation';

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
                    const itemId = Zotero.Items.getIDFromLibraryAndKey(derivedAnnotation.library_id, derivedAnnotation.parent_key);
                    if (itemId) {
                        navigateToPage(itemId, derivedAnnotation.position.page_index + 1);
                    }
                }}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate`}>
                    {displayText}
                </span>
                {currentReaderAttachmentKey !== derivedAnnotation.parent_key && <Icon icon={ArrowUpRightIcon} className="scale-11" /> }
            </button>
        )
    }
) 