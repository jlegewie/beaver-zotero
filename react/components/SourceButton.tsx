import React, { useEffect, useState, forwardRef, useRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { InputSource } from '../types/sources'
import { useSetAtom, useAtom, useAtomValue } from 'jotai'
import { readerItemKeyAtom, removeSourceAtom, togglePinSourceAtom } from '../atoms/input'
import { getDisplayNameFromItem, getZoteroItem, isSourceValid } from '../utils/sourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewCloseTimeoutAtom, activePreviewAtom } from '../atoms/ui'
import { truncateText } from '../utils/stringUtils'
import { BookmarkIcon, Icon } from './icons'
import { CancelIcon } from './icons'
// import Button from './Button'
import { atom } from 'jotai'
import IconButton from './IconButton'
import MissingSourceButton from './MissingSourceButton'

const MAX_SOURCEBUTTON_TEXT_LENGTH = 20;

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
        const [isHovered, setIsHovered] = useState(false);
        const [displayName, setDisplayName] = useState<string>('');
        const removeSource = useSetAtom(removeSourceAtom);
        const setActivePreview = useSetAtom(activePreviewAtom);
        const togglePinSource = useSetAtom(togglePinSourceAtom);
        const readerItemKey = useAtomValue(readerItemKeyAtom);
        const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);

        // Get the Zotero item
        const item = getZoteroItem(source);
        if (!item) return <MissingSourceButton source={source} />;
        
        // Hover timer ref for triggering preview display
        const showPreviewTimerRef = useRef<number | null>(null);

        // Moved item null check after hooks, before useEffects that depend on item
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

        // Timer Utilities (moved outside handlers for clarity)
        const cancelCloseTimer = () => {
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
                setPreviewCloseTimeout(null);
            }
        };

        const startCloseTimer = () => {
            cancelCloseTimer(); // Ensure no duplicate timers
            const newTimeout = Zotero.getMainWindow().setTimeout(() => {
                setActivePreview(null); // Close preview after delay
                setPreviewCloseTimeout(null);
            }, 350); // Delay before closing
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
            cancelCloseTimer(); // Stop any pending close timer immediately
            cancelShowPreviewTimer(); // Clear any pending show timer

            // Show preview after a short delay, only if valid
            if (isValid) {
                showPreviewTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
                    setActivePreview({ type: 'source', content: source });
                    showPreviewTimerRef.current = null; // Clear ref after execution
                }, 100); // Short delay before showing
            }
        };

        const handleMouseLeave = () => {
            setIsHovered(false);
            cancelShowPreviewTimer(); // Cancel the timer to show if mouse leaves quickly
            startCloseTimer(); // Start the timer to close the preview (will be canceled if mouse enters preview area)
        };

        // Cleanup timers on unmount
        useEffect(() => {
            return () => {
                cancelShowPreviewTimer();
                // No need to explicitly call cancelCloseTimer here, 
                // as the PreviewContainer will handle its own cleanup if needed.
            };
        }, []);

        useEffect(() => {
            const checkSourceValidity = async () => {
                setIsValid(await isSourceValid(source));
            }
            checkSourceValidity();
        }, [source])

        // Ensure handleRemove still works correctly
        const handleRemove = () => {
            cancelShowPreviewTimer(); // Prevent preview from showing if removed quickly
            cancelCloseTimer();    // Prevent preview from closing then reopening if button removed
            setActivePreview(null); // Ensure preview is closed if it was open
            removeSource(source);
        }
        
        // Update onClick for toggling pin
        const handlePinClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            if (isValid && canEdit) {
                togglePinSource(source.id);
                // Optionally close preview on pin toggle, or let it stay
                // setActivePreview(null); 
            }
            if (!canEdit && item) {
                 // @ts-ignore selectItem exists
                 Zotero.getActiveZoteroPane().itemsView.selectItem(item.id);
            }
        }

        const getIconElement = () => {
            if (isHovered && readerItemKey != source.itemKey && canEdit && isValid) { // Check isValid
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
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={
                    `variant-outline source-button
                    ${className || ''}
                    ${disabled ? 'disabled-but-styled' : ''}
                    ${source.type === "regularItem" && source.childItemKeys.length == 0 ? 'opacity-60' : ''}
                    ${!isValid ? 'border-red' : ''} 
                `}
                disabled={disabled}
                onClick={handlePinClick} // Use updated handler
                {...rest}
            >
                {getIconElement()}
                <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                    {displayName || '...'}
                </span>
                {readerItemKey == source.itemKey && <Icon icon={BookmarkIcon} className="scale-11" /> }
                {!disabled && source.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="-mr-015" />}
            </button>
        )
    }
)