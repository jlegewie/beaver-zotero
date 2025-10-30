import React, { forwardRef } from 'react';
import { CSSItemTypeIcon, CSSIcon, Spinner, Icon, ArrowUpRightIcon } from "../icons/icons";
import { useAtomValue } from 'jotai';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { usePreviewHover } from '../../hooks/usePreviewHover';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { truncateText } from '../../utils/stringUtils';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/messageComposition';
import { toAnnotation } from '../../types/attachments/converters';

const MAX_ITEM_TEXT_LENGTH = 20;

const ANNOTATION_TEXT_BY_TYPE = {
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

interface MessageItemButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'item'> {
    item: Zotero.Item;
    canEdit?: boolean;
    disabled?: boolean;
    onRemove?: (item: Zotero.Item) => void;
    isReaderAttachment?: boolean;
}

/**
 * Button component for displaying a Zotero item in message composition
 * Supports both regular items and annotations
 * Shows validation state, item/annotation icon, and allows removal
 */
export const MessageItemButton = forwardRef<HTMLButtonElement, MessageItemButtonProps>(
    function MessageItemButton(props: MessageItemButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            item,
            className,
            disabled = false,
            canEdit = true,
            onRemove,
            isReaderAttachment = false,
            ...rest
        } = props;

        // Check if item is an annotation
        const isAnnotation = item.isAnnotation();
        const annotation = isAnnotation ? toAnnotation(item) : null;

        // Get current reader attachment key for annotation display
        const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

        // Get validation state
        const getValidation = useAtomValue(getItemValidationAtom);
        const validation = getValidation(item);

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            isAnnotation 
                ? { type: 'annotation', content: item }
                : { type: 'item', content: item },
            { isEnabled: !disabled }
        );

        // Determine display name based on item type
        const displayName = isAnnotation && annotation
            ? ANNOTATION_TEXT_BY_TYPE[annotation.annotation_type] || 'Annotation'
            : item.isRegularItem() 
                ? getDisplayNameFromItem(item) 
                : truncateText(item.getDisplayTitle(), MAX_ITEM_TEXT_LENGTH);

        // Handle remove
        const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
            e.stopPropagation();
            cancelTimers();
            if (onRemove) {
                onRemove(item);
            }
        };

        // Handle button click
        const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            
            // For annotations, navigate to the annotation in the reader
            if (isAnnotation) {
                navigateToAnnotation(item);
                return;
            }
            
            // For regular items, select in Zotero
            try {
                const win = Zotero.getMainWindow();
                if (win && win.ZoteroPane) {
                    win.ZoteroPane.selectItem(item.id);
                }
            } catch (error) {
                console.error('Failed to select item:', error);
            }
        };

        // Get icon element based on validation state
        const getIconElement = () => {
            // Show spinner during validation
            if (validation?.isValidating) {
                return (
                    <CSSIcon name="spinner" className="icon-16 scale-11">
                        <Spinner className="mt-020" />
                    </CSSIcon>
                );
            }

            // Show remove icon on hover (if editable)
            if (isHovered && canEdit && !disabled) {
                return (
                    <span role="button" className={`source-remove ${isAnnotation ? '-ml-015' : ''}`} onClick={handleRemove}>
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                );
            }

            // Show annotation-specific icon
            if (isAnnotation && annotation) {
                return (
                    <ZoteroIcon icon={ANNOTATION_ICON_BY_TYPE[annotation.annotation_type]} size={14} />
                );
            }

            // Show item type icon
            try {
                const iconName = item.getItemTypeIconName();
                return iconName ? (
                    <span className="scale-80">
                        <CSSItemTypeIcon itemType={iconName} />
                    </span>
                ) : null;
            } catch (error) {
                return null;
            }
        };

        // Determine button styling based on validation state
        const getButtonClasses = () => {
            const baseClasses = `variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
            
            // Invalid state
            if (validation && !validation.isValid && !validation.isValidating) {
                return `${baseClasses} border-red`;
            }
            
            // Valid and backend checked
            if (validation?.backendChecked && validation.isValid) {
                return `${baseClasses} border-green`;
            }
            
            return baseClasses;
        };

        // Tooltip text
        const getTooltipTitle = () => {
            if (validation?.isValidating) {
                return 'Validating...';
            }
            if (validation && !validation.isValid && validation.reason) {
                return validation.reason;
            }
            return undefined;
        };

        return (
            <button
                ref={ref}
                style={{ height: '22px' }}
                title={getTooltipTitle()}
                {...hoverEventHandlers}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={handleButtonClick}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate ${validation && !validation.isValid ? 'font-color-red' : ''}`}>
                    {isReaderAttachment
                        ? (validation && !validation.isValid) ? 'Invalid File' : 'Current File'
                        : displayName || '...'}
                </span>
                
                {/* Show arrow icon for annotations not in current reader */}
                {isAnnotation && annotation && currentReaderAttachmentKey !== annotation.parent_key && (
                    <Icon icon={ArrowUpRightIcon} className="scale-11" />
                )}
                
                {/* Validation status indicator */}
                {validation?.backendChecked && (
                    <span className="validation-indicator">
                        {validation.isValid ? (
                            <CSSIcon name="checkmark" className="icon-12 text-green" />
                        ) : (
                            <CSSIcon name="alert" className="icon-12 text-red" />
                        )}
                    </span>
                )}
            </button>
        );
    }
);
