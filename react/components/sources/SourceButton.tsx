import React, { useEffect, useState, forwardRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "../icons/icons"
import { InputSource } from '../../types/sources'
import { useSetAtom, useAtomValue } from 'jotai'
import { currentReaderAttachmentKeyAtom, removeSourceAtom, togglePinSourceAtom } from '../../atoms/input'
import { getDisplayNameFromItem, getZoteroItem, isSourceValid } from '../../utils/sourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { truncateText } from '../../utils/stringUtils'
import { BookmarkIcon, Icon } from '../icons/icons'
import MissingSourceButton from './MissingSourceButton'
import { usePreviewHover } from '../../hooks/usePreviewHover'
import { activePreviewAtom } from '../../atoms/ui'
import { getPref } from '../../../src/utils/prefs'

const MAX_SOURCEBUTTON_TEXT_LENGTH = 20;
const updateSourcesFromZoteroSelection = getPref("updateSourcesFromZoteroSelection");

interface SourceButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    source: InputSource
    canEdit?: boolean
    disabled?: boolean
}

export const SourceButton = forwardRef<HTMLButtonElement, SourceButtonProps>(
    function SourceButton(props: SourceButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) {
        const {
            source,
            className,
            disabled = false,
            canEdit = true,
            ...rest
        } = props

        // States
        const [isValid, setIsValid] = useState(true);
        const [displayName, setDisplayName] = useState<string>('');
        const removeSource = useSetAtom(removeSourceAtom);
        const setActivePreview = useSetAtom(activePreviewAtom);
        const togglePinSource = useSetAtom(togglePinSourceAtom);
        const currentReaderAttachmentKey = useAtomValue(currentReaderAttachmentKeyAtom);

        // Use the custom hook for hover preview logic
        const { hoverEventHandlers, isHovered, cancelTimers } = usePreviewHover(
            isValid ? { type: 'source', content: source } : null, // Preview content
            { isEnabled: !disabled } // Options: disable if button is disabled or invalid
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

        // Update the validation status when the source changes
        useEffect(() => {
            const checkSourceValidity = async () => {
                setIsValid(await isSourceValid(source));
            }
            checkSourceValidity();
        }, [source])

        // Remove the source
        const handleRemove = () => {
            cancelTimers(); // Cancel preview timers before removing
            setActivePreview(null); // Explicitly close any active preview
            removeSource(source);
        }

        // Handle button click
        const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            if (isValid && canEdit && updateSourcesFromZoteroSelection) {
                togglePinSource(source.id);
            }
            else if (item) {
                // @ts-ignore selectItem exists
                Zotero.getActiveZoteroPane().itemsView.selectItem(item.id);
            }
        }

        // Get the icon element
        const getIconElement = () => {
            // Remove icon on hover if not the current reader attachment
            if (isHovered && currentReaderAttachmentKey != source.itemKey) {
                return (<span
                    role="button"
                    className="source-remove"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove() // Use internal handleRemove
                    }}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>)
            }

            // Show spinner when validation is in progress
            // if (source.validationState === 'loading') {
            //     return <CSSIcon name="spinner" className="icon-16 scale-11" >
            //         <Spinner className="mt-020" />
            //     </CSSIcon>
            // }

            // Show item type icon
            const iconName = item.getItemTypeIconName();
            const iconElement = iconName ? (
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
            ) : null
            return iconElement
        }

        return (
            <button
                ref={ref}
                {...hoverEventHandlers}
                className={
                    `variant-outline source-button
                    ${className || ''}
                    ${disabled ? 'disabled-but-styled' : ''}
                    ${source.type === "regularItem" && source.childItemKeys.length == 0 ? 'opacity-60' : ''}
                    ${!isValid ? 'border-red' : ''}
                `}
                disabled={disabled}
                onClick={handleButtonClick}
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                    {displayName || '...'}
                </span>
                {currentReaderAttachmentKey == source.itemKey && <Icon icon={BookmarkIcon} className="scale-11" /> }
                {updateSourcesFromZoteroSelection && !disabled && source.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="-mr-015" />}
            </button>
        )
    }
)