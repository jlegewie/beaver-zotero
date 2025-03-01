// @ts-ignore no idea
import React, { useEffect, useState, forwardRef, useRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Source } from '../types/sources'
import { useSetAtom, useAtom } from 'jotai'
import { removeSourceAtom, togglePinSourceAtom } from '../atoms/sources'
import { isSourceValid } from '../utils/sourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewedSourceAtom } from '../atoms/ui'

// Create a shared close timeout atom to coordinate between SourceButton and SourcePreview
import { atom } from 'jotai'
export const previewCloseTimeoutAtom = atom<number | null>(null)

interface SourceButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'source'> {
    source: Source
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
        
        // Hover timer ref for handling delayed hover behavior
        const hoverTimerRef = useRef<number | null>(null);

        const getIconElement = (source: Source, isHovered: boolean) => {
            if (isHovered) {
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
            if (source.icon) {
                const iconElement = source.icon ? (
                    <span className="source-button-icon">
                        <CSSItemTypeIcon itemType={source.icon} />
                    </span>
                ) : null
                return iconElement
            }
            return null
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
            const checkAttachmentValidity = async () => {
                setIsValid(await isSourceValid(source));
            }
            checkAttachmentValidity();
        }, [source])

        return (
            <button
                ref={ref}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={`source-button ${className || ''}`}
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
                {getIconElement(source, isHovered)}
                <span className={!isValid ? 'font-color-red' : undefined}>
                    {source.name}
                </span>
                {!disabled && source.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="ml-1 -mr-1" />}
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