import React, { forwardRef, useRef, useState } from 'react';
import { CSSItemTypeIcon, CSSIcon, Spinner, Icon, ArrowUpRightIcon, CancelIcon, DeleteIcon } from "../icons/icons";
import { useAtomValue } from 'jotai';
import ContextMenu, { MenuItem, MenuPosition } from '../ui/menu/ContextMenu';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { usePreviewHover } from '../../hooks/usePreviewHover';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { truncateText } from '../../utils/stringUtils';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { currentReaderAttachmentKeyAtom } from '../../atoms/messageComposition';
import { toAnnotation } from '../../types/attachments/converters';
import { selectItemById } from '../../../src/utils/selectItem';
import { openNoteById } from '../../utils/sourceUtils';

const MAX_ITEM_TEXT_LENGTH = 30;

const ANNOTATION_TEXT_BY_TYPE = {
    highlight: 'Highlight',
    underline: 'Underline',
    note: 'Sticky Note',
    image: 'Area',
}

export const ANNOTATION_ICON_BY_TYPE = {
    highlight: ZOTERO_ICONS.ANNOTATE_HIGHLIGHT,
    underline: ZOTERO_ICONS.ANNOTATE_UNDERLINE,
    note: ZOTERO_ICONS.ANNOTATION,
    text: ZOTERO_ICONS.ANNOTATE_TEXT,
    image: ZOTERO_ICONS.ANNOTATE_AREA,
}

interface MessageItemButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'item'> {
    item: Zotero.Item;
    canEdit?: boolean;
    disabled?: boolean;
    onRemove?: (item: Zotero.Item) => void;
    /**
     * Optional callback to remove all editable context items at once.
     * When provided (and the button is editable), long-pressing the remove "x"
     * opens a small menu offering "Remove" and "Remove all".
     */
    onRemoveAll?: () => void;
    tabContextType?: 'reader' | 'note';
    showInvalid?: boolean;
    /** Optional collection key to reveal the item within when clicked */
    revealInCollectionKey?: string;
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
            onRemoveAll,
            tabContextType,
            showInvalid = true,
            revealInCollectionKey,
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
            : (item.isRegularItem() || item.isNote())
                ? item.isRegularItem() ? truncateText(getDisplayNameFromItem(item), MAX_ITEM_TEXT_LENGTH) : getDisplayNameFromItem(item)
                : truncateText(item.getDisplayTitle(), MAX_ITEM_TEXT_LENGTH);

        // Whether the long-press "remove" menu is available for this button
        const canShowRemoveMenu = Boolean(onRemoveAll) && canEdit && !disabled;

        // Long-press state for the remove "x" menu
        const [isRemoveMenuOpen, setIsRemoveMenuOpen] = useState(false);
        const [removeMenuPosition, setRemoveMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
        const longPressTimerRef = useRef<number | null>(null);
        // Set when a long-press fires so the subsequent click doesn't also remove the item
        const suppressClickRef = useRef(false);

        const clearLongPressTimer = () => {
            if (longPressTimerRef.current !== null) {
                Zotero.getMainWindow().clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
            }
        };

        const handleRemoveMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
            // Only react to the primary (left) button and when the menu is available
            if (!canShowRemoveMenu || e.button !== 0) return;
            e.stopPropagation();
            const { clientX, clientY } = e;
            suppressClickRef.current = false;
            clearLongPressTimer();
            longPressTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
                suppressClickRef.current = true;
                longPressTimerRef.current = null;
                cancelTimers();
                setRemoveMenuPosition({ x: clientX, y: clientY });
                setIsRemoveMenuOpen(true);
            }, 400);
        };

        // Handle remove
        const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
            e.stopPropagation();
            clearLongPressTimer();
            // Skip the click that ends a long-press (the menu handles the action)
            if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
            }
            cancelTimers();
            if (onRemove) {
                onRemove(item);
            }
        };

        const removeMenuItems: MenuItem[] = [
            {
                label: 'Remove',
                icon: CancelIcon,
                onClick: () => {
                    if (onRemove) onRemove(item);
                }
            },
            {
                label: 'Remove all',
                icon: DeleteIcon,
                onClick: () => {
                    if (onRemoveAll) onRemoveAll();
                }
            }
        ];

        // Handle button click
        const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            
            // For annotations, navigate to the annotation in the reader
            if (isAnnotation) {
                navigateToAnnotation(item);
                return;
            }

            // For notes, open the note in editor (tab or window per user preference)
            if (item.isNote()) {
                openNoteById(item.id);
                return;
            }

            // For regular items, select in Zotero
            try {
                // If a collection key is provided, reveal in that collection
                if (revealInCollectionKey) {
                    const collectionId = Zotero.Collections.getIDFromLibraryAndKey(item.libraryID, revealInCollectionKey);
                    selectItemById(item.id, true, collectionId !== false ? collectionId : undefined);
                } else {
                    const win = Zotero.getMainWindow();
                    if (win && win.ZoteroPane) {
                        win.ZoteroPane.selectItem(item.id);
                    }
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

            // Show remove icon on hover (if editable). Keep it visible while the
            // long-press menu is open so the trigger doesn't disappear.
            if ((isHovered || isRemoveMenuOpen) && canEdit && !disabled) {
                return (
                    <span
                        role="button"
                        className={`source-remove ${isAnnotation ? '-ml-015' : ''}`}
                        onClick={handleRemove}
                        onMouseDown={handleRemoveMouseDown}
                        onMouseUp={clearLongPressTimer}
                        onMouseLeave={clearLongPressTimer}
                        title={canShowRemoveMenu ? 'Remove (long-press for more)' : undefined}
                    >
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
            if (showInvalid && validation && !validation.isValid && !validation.isValidating) {
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
            <>
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
                    {tabContextType === 'reader'
                        ? (validation && !validation.isValid && showInvalid) ? 'Invalid File' : 'Current File'
                        : tabContextType === 'note'
                            ? 'Current Note'
                            : displayName || '...'}
                </span>
                
                {/* Show arrow icon for annotations not in current reader */}
                {isAnnotation && annotation && currentReaderAttachmentKey !== annotation.parent_key && (
                    <Icon icon={ArrowUpRightIcon} className="scale-11" />
                )}
                
                {/* Validation status indicator */}
                {validation?.backendChecked && showInvalid && (
                    <span className="validation-indicator">
                        {validation.isValid ? (
                            <CSSIcon name="checkmark" className="icon-12 text-green" />
                        ) : (
                            <CSSIcon name="alert" className="icon-12 text-red" />
                        )}
                    </span>
                )}
            </button>
            {canShowRemoveMenu && (
                <ContextMenu
                    menuItems={removeMenuItems}
                    isOpen={isRemoveMenuOpen}
                    onClose={() => setIsRemoveMenuOpen(false)}
                    position={removeMenuPosition}
                    useFixedPosition={true}
                    usePortal={true}
                    width="160px"
                />
            )}
            </>
        );
    }
);
