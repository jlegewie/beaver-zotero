import React, { useEffect, useState, forwardRef } from 'react'
import { CSSItemTypeIcon, CSSIcon, Spinner } from "../icons/icons"
import { InputSource } from '../../types/sources'
import { useSetAtom, useAtomValue } from 'jotai'
import { currentReaderAttachmentKeyAtom, removeSourceAtom, togglePinSourceAtom } from '../../atoms/input'
import { getDisplayNameFromItem, getZoteroItem } from '../../utils/sourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { truncateText } from '../../utils/stringUtils'
import { BookmarkIcon, Icon } from '../icons/icons'
import MissingSourceButton from './MissingSourceButton'
import { usePreviewHover } from '../../hooks/usePreviewHover'
import { activePreviewAtom } from '../../atoms/ui'
import { getPref } from '../../../src/utils/prefs'
import { selectItem } from '../../../src/utils/selectItem'
import { useSourceValidation } from '../../hooks/useSourceValidation'
import { SourceValidationType } from '../../../src/services/sourceValidationManager'

const MAX_SOURCEBUTTON_TEXT_LENGTH = 20;
const updateSourcesFromZoteroSelection = getPref("updateSourcesFromZoteroSelection");

interface SourceButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    source: InputSource
    canEdit?: boolean
    disabled?: boolean
    validationType?: SourceValidationType
}

export const SourceButton = forwardRef<HTMLButtonElement, SourceButtonProps>(
    function SourceButton(props: SourceButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            source,
            className,
            disabled = false,
            canEdit = true,
            validationType = SourceValidationType.PROCESSED_FILE,
            ...rest
        } = props

        // Validate source attachment
        const validation = useSourceValidation({ source, validationType });

        const [displayName, setDisplayName] = useState<string>('');
        const removeSource = useSetAtom(removeSourceAtom);
        const setActivePreview = useSetAtom(activePreviewAtom);
        const togglePinSource = useSetAtom(togglePinSourceAtom);
        const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            validation.isValid ? { type: 'source', content: source } : null,
            { isEnabled: !disabled }
        );

        // Get the Zotero item
        const item = getZoteroItem(source);
        if (!item) return <MissingSourceButton source={source} />;

        // Update the display name when the item changes
        useEffect(() => {
            if (!item) {
                setDisplayName('Missing Source');
                return;
            }

            let name = getDisplayNameFromItem(item);
            if (source.childItemKeys.length > 1) {
                name = `${name} (${source.childItemKeys.length})`;
            }
            const truncatedName = truncateText(name, MAX_SOURCEBUTTON_TEXT_LENGTH);
            setDisplayName(truncatedName);
        }, [item, source.childItemKeys.length]);

        // Remove the source
        const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
            e.stopPropagation();
            cancelTimers(); // Cancel preview timers before removing
            setActivePreview(null); // Explicitly close any active preview
            removeSource(source);
        }

        // Handle button click
        const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            if (validation.isValid && canEdit && updateSourcesFromZoteroSelection) {
                togglePinSource(source.id);
            }
            else if (item) {
                selectItem(item);
            }
        }

        // Get the icon element with validation states
        const getIconElement = () => {
            // Show spinner during validation/upload
            if (validation.isValidating) {
                return <CSSIcon name="spinner" className="icon-16 scale-11" >
                    <Spinner className="mt-020" />
                </CSSIcon>
            }

            // Show remove icon on hover (if not current reader attachment)
            if (isHovered && canEdit && currentReaderAttachmentKey != source.itemKey) {
                return (
                    <span role="button" className="source-remove" onClick={handleRemove}>
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                );
            }

            // Show item type icon
            const iconName = item.getItemTypeIconName();
            return iconName ? (
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
            ) : null;
        }

        // Determine button styling based on validation state
        const getButtonClasses = () => {
            const baseClasses = `variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
            
            if (!validation.isValid) {
                return `${baseClasses} border-red`;
            }
            
            if (validation.backendChecked && validation.isValid) {
                return `${baseClasses} border-green`;
            }
            
            if (source.type === "regularItem" && source.childItemKeys.length == 0) {
                return `${baseClasses} opacity-60`;
            }
            
            return baseClasses;
        }

        // Simplified tooltip logic
        const getTooltipTitle = () => {
            if (validation.isValidating) {
                return 'Validating and uploading if needed...';
            }
            if (!validation.isValid && validation.reason) {
                return validation.reason;
            }
            return undefined;
        }

        const sourceButton = (
            <button
                ref={ref}
                style={{height: '22px'}}
                title={getTooltipTitle()}
                {...hoverEventHandlers}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={handleButtonClick}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate ${!validation.isValid ? 'font-color-red' : ''}`}>
                    {displayName || '...'}
                </span>
                {currentReaderAttachmentKey == source.itemKey && <Icon icon={BookmarkIcon} className="scale-11" />}
                {updateSourcesFromZoteroSelection && !disabled && source.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="-mr-015" />}
                {/* Validation status indicator */}
                {validation.backendChecked && (
                    <span className="validation-indicator">
                        {validation.isValid ? (
                            <CSSIcon name="checkmark" className="icon-12 text-green" />
                        ) : (
                            <CSSIcon name="alert" className="icon-12 text-red" />
                        )}
                    </span>
                )}
                {validation.uploaded && (
                    <CSSIcon name="upload" className="icon-12 text-blue" title="Recently uploaded" />
                )}
            </button>
        )

        return sourceButton;
    }
)