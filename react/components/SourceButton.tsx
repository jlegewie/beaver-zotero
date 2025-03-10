// @ts-ignore no idea
import React, { useEffect, useState, forwardRef, useRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { InputSource } from '../types/sources'
import { useSetAtom, useAtom } from 'jotai'
import { removeSourceAtom, togglePinSourceAtom } from '../atoms/input'
import { getDisplayNameFromItem, getZoteroItem, isSourceValid } from '../utils/sourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewedSourceAtom } from '../atoms/ui'
import { truncateText } from '../utils/stringUtils'
import { CancelIcon } from './icons'
import Button from './Button'

const MAX_SOURCEBUTTON_TEXT_LENGTH = 20;

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
import { atom } from 'jotai'
import IconButton from './IconButton'
export const previewCloseTimeoutAtom = atom<number | null>(null)

interface SourceButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    source: InputSource
    disabled?: boolean
}

export const SourceButton = forwardRef<HTMLButtonElement, SourceButtonProps>(
    function SourceButton(props: SourceButtonProps, ref: React.RefObject<HTMLButtonElement>) {
        const {
            source,
            className,
            disabled = false,
            ...rest
        } = props
        // States
        const [isValid, setIsValid] = useState(true);
        const [isHovered, setIsHovered] = useState(false);
        const removeSource = useSetAtom(removeSourceAtom);
        const setPreviewedSource = useSetAtom(previewedSourceAtom);
        const togglePinSource = useSetAtom(togglePinSourceAtom);
        const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);

        // Get the Zotero item
        const item = getZoteroItem(source);
        if (!item) return null;
        
        // Hover timer ref for handling delayed hover behavior
        const hoverTimerRef = useRef<number | null>(null);

        const getIconElement = (source: InputSource, isHovered: boolean, disabled: boolean) => {
            if (isHovered) {
                // return (<IconButton
                //     icon={CancelIcon}
                //     className="scale-80 m-0 p-0"
                //     onClick={(e) => {
                //         e.stopPropagation()
                //         handleRemove()
                //     }}
                // />)
                return (<span 
                    role="button"
                    className="source-remove"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove()
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

        const handleRemove = () => {
            removeSource(source)
        }

        // Start a timeout to close the preview after delay
        const startCloseTimer = () => {
            // Clear any existing timeout
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
            }
            
            // Start a new timeout
            const newTimeout = Zotero.getMainWindow().setTimeout(() => {
                setPreviewedSource(null);
                setPreviewCloseTimeout(null);
            }, 350); // 300ms delay before closing
            
            setPreviewCloseTimeout(newTimeout);
        };

        const cancelCloseTimer = () => {
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
                setPreviewCloseTimeout(null);
            }
        };

        const handleMouseEnter = () => {
            setIsHovered(true);
            cancelCloseTimer();
            
            // Show preview with a small delay to prevent flashing during quick mouse movements
            if (hoverTimerRef.current) {
                Zotero.getMainWindow().clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            
            // Only show preview if the source is valid
            if (isValid) {
                hoverTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
                    setPreviewedSource(source);
                }, 100); // Shorter delay of 100ms before showing preview
            }
        };

        const handleMouseLeave = () => {
            setIsHovered(false);
            
            // Clear any pending show timers
            if (hoverTimerRef.current) {
                Zotero.getMainWindow().clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            
            // Start the close timer when mouse leaves button
            // This will be canceled if mouse enters preview quickly enough
            startCloseTimer();
        };

        // Cleanup timers on unmount
        useEffect(() => {
            return () => {
                if (hoverTimerRef.current) {
                    Zotero.getMainWindow().clearTimeout(hoverTimerRef.current);
                }
                cancelCloseTimer();
            };
        }, []);

        useEffect(() => {
            const checkSourceValidity = async () => {
                setIsValid(await isSourceValid(source));
            }
            checkSourceValidity();
        }, [source])

        // Truncate the name and add a count if there are child items
        let displayName = truncateText(getDisplayNameFromItem(item), MAX_SOURCEBUTTON_TEXT_LENGTH);
        if (source.childItemKeys.length > 1) displayName = `${displayName} (${source.childItemKeys.length})`;

        return (
            <button
                ref={ref}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={
                    `variant-outline source-button
                    ${className || ''}
                    ${disabled ? 'disabled-but-styled' : ''}
                    ${source.isRegularItem && source.childItemKeys.length == 0 ? 'opacity-60' : ''}
                `}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation();
                    if (isValid) {
                        togglePinSource(source.id);
                    }
                }}
                {...rest}
            >
                {/* {isHovered && isValid === true && attachment.type === 'zotero_item' && !pinnedItems.includes(attachment.item)
                    ? <span className="source-button-icon"><Icon icon={PinIcon} className="icon-16" /></span>
                    : getIconElement(attachment)
                } */}
                {getIconElement(source, isHovered, disabled)}
                <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                    {displayName}
                </span>
                {!disabled && source.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="-mr-015" />}
                {/* {!disabled && (
                    <span 
                        role="button"
                        className="source-remove"
                        onClick={(e) => {
                            e.stopPropagation()
                            handleRemove()
                        }}
                    >
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                )} */}
            </button>
        )
    }
)