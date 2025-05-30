import React, { forwardRef, useEffect, useState } from 'react'
import { CSSIcon, Icon, ArrowUpRightIcon } from "../icons/icons"
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { useSetAtom, useAtomValue } from 'jotai'
import { activePreviewAtom } from '../../atoms/ui'
import { usePreviewHover } from '../../hooks/usePreviewHover'
import { currentReaderAttachmentKeyAtom, currentSourcesAtom } from '../../atoms/input';
import { Annotation } from '../../types/attachments/apiTypes';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { InputSource } from '../../types/sources';
import { toAnnotation } from '../../types/attachments/converters';
import { getZoteroItem, isValidZoteroItem } from '../../utils/sourceUtils';

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
    source: InputSource
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
        const setCurrentSourcesAtom = useSetAtom(currentSourcesAtom);
        const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);
        const [derivedAnnotation, setDerivedAnnotation] = useState<Annotation | null>(null);
        const [isValid, setIsValid] = useState(true);
        const [invalidReason, setInvalidReason] = useState<string | null>(null);

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            { type: 'annotation', content: source },
            // Options: Disable if derivedAnnotation undefined, button disabled, not editable, or invalid
            { isEnabled: !disabled && canEdit && !!derivedAnnotation && isValid }
        )

        useEffect(() => {
            let zoteroItem: Zotero.Item | null = null;
            // When annotation prop is provided directly, use it
            if (annotationProp) {
                setDerivedAnnotation(annotationProp);
                // Try to get the item directly using the annotation's key
                zoteroItem = Zotero.Items.getByLibraryAndKey(annotationProp.library_id, annotationProp.zotero_key) || null;
            }
            // Otherwise try to derive from source
            else if (source) {
                const item = getZoteroItem(source);
                if (item && item.isAnnotation()) {
                    setDerivedAnnotation(toAnnotation(item));
                    zoteroItem = item;
                } else {
                    setDerivedAnnotation(null);
                }
            } else {
                setDerivedAnnotation(null);
            }

            // Perform validation if we have a zoteroItem
            const checkValidity = async () => {
                if (zoteroItem) {
                    const {valid, error} = await isValidZoteroItem(zoteroItem);
                    setIsValid(valid);
                    if (!valid) {
                        setInvalidReason(error || "Unknown error");
                    }
                } else {
                    setIsValid(false);
                    setInvalidReason("Item not found");
                }
            };
            checkValidity();

        }, [annotationProp, source]);

        // Early return if no annotation is available
        if (!derivedAnnotation) return null;

        // Handle removal: Use the provided callback if available
        const handleRemove = () => {
            cancelTimers() // Cancel preview timers
            setActivePreview(null) // Ensure preview is explicitly closed
            setCurrentSourcesAtom((prev) => prev.filter((a) => a.itemKey !== derivedAnnotation.zotero_key))
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
                    ${!isValid ? 'border-red' : ''}
                `}
                // Disable button click if invalid
                disabled={disabled || !isValid}
                onClick={async (e) => {
                    e.stopPropagation();
                    const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(derivedAnnotation.library_id, derivedAnnotation.zotero_key);
                    if (annotationItem) {
                        navigateToAnnotation(annotationItem);
                    }
                }}
                {...rest}
            >
                {getIconElement()}
                {/* Add red text color if invalid */}
                <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                    {displayText}
                </span>
                {currentReaderAttachmentKey !== derivedAnnotation.parent_key && <Icon icon={ArrowUpRightIcon} className="scale-11" /> }
            </button>
        )
    }
) 