import React, { forwardRef } from 'react';
import { CSSItemTypeIcon, CSSIcon, Spinner } from "../icons/icons";
import { useAtomValue } from 'jotai';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { usePreviewHover } from '../../hooks/usePreviewHover';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';

const MAX_ITEM_TEXT_LENGTH = 20;

interface MessageItemButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'item'> {
    item: Zotero.Item;
    canEdit?: boolean;
    disabled?: boolean;
    onRemove?: (item: Zotero.Item) => void;
}

/**
 * Button component for displaying a Zotero item in message composition
 * Shows validation state, item icon, and allows removal
 */
export const MessageItemButton = forwardRef<HTMLButtonElement, MessageItemButtonProps>(
    function MessageItemButton(props: MessageItemButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            item,
            className,
            disabled = false,
            canEdit = true,
            onRemove,
            ...rest
        } = props;

        // Get validation state
        const getValidation = useAtomValue(getItemValidationAtom);
        const validation = getValidation(item);

        const displayName = getDisplayNameFromItem(item);

        // Handle remove
        const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
            e.stopPropagation();
            if (onRemove) {
                onRemove(item);
            }
        };

        // Handle button click
        const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            // TODO: Navigate to item in Zotero
            // For now, just select the item
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
                    <span role="button" className="source-remove" onClick={handleRemove}>
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
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
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={handleButtonClick}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate ${validation && !validation.isValid ? 'font-color-red' : ''}`}>
                    {displayName || '...'}
                </span>
                
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
