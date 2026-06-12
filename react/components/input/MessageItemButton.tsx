import React, { forwardRef } from 'react';
import { CSSItemTypeIcon, CSSIcon, Spinner, Icon, ArrowUpRightIcon, LibraryIcon, PdfIcon, NoteIcon, FileViewIcon } from "../icons/icons";
import { useAtomValue } from 'jotai';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { MenuItem } from '../ui/menu/ContextMenu';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { usePreviewHover } from '../../hooks/usePreviewHover';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { truncateText } from '../../utils/stringUtils';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { navigateToAnnotation, isItemActiveTab } from '../../utils/readerUtils';
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

        const isFileAttachment = item.isAttachment() && item.isFileAttachment();

        // Reveal the item in the Zotero library pane. Works for notes,
        // attachments, and regular items — `selectItem` highlights whichever row
        // the item occupies.
        const revealInLibrary = () => {
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

        // Open the attachment file in the reader (or its external app).
        const openAttachment = () => {
            Zotero.getActiveZoteroPane()?.viewAttachment(item.id);
        };

        // Primary action for a left-click on the button. Annotations jump to the
        // reader, notes open in the editor, and everything else is revealed in
        // the Zotero library.
        const revealItem = () => {
            if (isAnnotation) {
                navigateToAnnotation(item);
                return;
            }
            if (item.isNote()) {
                openNoteById(item.id);
                return;
            }
            revealInLibrary();
        };

        // Context-menu reveal/open actions, depending on the item type. Types
        // that support more than one action (notes, file attachments) show both:
        // one to reveal the item in the library and one to open it. The "open"
        // action is disabled only when the item's tab is the one currently in
        // view — when it is open in a background tab, opening it switches to that
        // tab.
        const revealMenuItems: MenuItem[] = isAnnotation
            ? [{ label: 'Reveal in PDF', icon: PdfIcon, onClick: () => navigateToAnnotation(item) }]
            : item.isNote()
                ? [
                    { label: 'Reveal in Library', icon: LibraryIcon, onClick: revealInLibrary },
                    { label: 'Open Note', icon: NoteIcon, onClick: () => openNoteById(item.id), disabled: isItemActiveTab(item.id) },
                ]
                : isFileAttachment
                    ? [
                        { label: 'Reveal in Library', icon: LibraryIcon, onClick: revealInLibrary },
                        { label: 'Open Attachment', icon: FileViewIcon, onClick: openAttachment, disabled: isItemActiveTab(item.id) },
                    ]
                    : [{ label: 'Reveal in Library', icon: LibraryIcon, onClick: revealInLibrary }];

        // Right-click "remove" menu for this button. A left-click on the "x"
        // removes just this item; right-clicking the button opens a menu with
        // the reveal/open actions plus "Remove" (and "Remove all" when more than
        // one removable item is attached).
        const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
            onRemove: () => {
                cancelTimers();
                if (onRemove) onRemove(item);
            },
            onRemoveAll,
            canEdit,
            disabled,
            onMenuOpen: cancelTimers,
            extraMenuItems: revealMenuItems,
        });

        // Handle button click
        const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            // Chrome documents dispatch click for non-primary buttons too
            // (right-click fires contextmenu AND click); only a left-click
            // reveals the item.
            if (e.button !== 0) return;
            revealItem();
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
                        {...removeHandlers}
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
                {...contextMenuHandlers}
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
            {removeMenu}
            </>
        );
    }
);
