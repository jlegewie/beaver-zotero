// @ts-ignore no idea
import React, { useEffect, useState, forwardRef, useRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Resource } from '../types/resources'
import { useSetAtom, useAtom } from 'jotai'
import { removeResourceAtom, togglePinResourceAtom } from '../atoms/resources'
import { isResourceValid } from '../utils/resourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewedResourceAtom } from '../atoms/ui'

// Create a shared close timeout atom to coordinate between ResourceButton and ResourcePreview
import { atom } from 'jotai'
export const previewCloseTimeoutAtom = atom<number | null>(null)

interface ResourceButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'resource'> {
    resource: Resource
    disabled?: boolean
}

export const ResourceButton = forwardRef<HTMLButtonElement, ResourceButtonProps>(
    function ResourceButton(props: ResourceButtonProps, ref: React.RefObject<HTMLButtonElement>) {
        const {
            resource,
            className,
            disabled = false,
            ...rest
        } = props
        // States
        const [isValid, setIsValid] = useState(true);
        const [isHovered, setIsHovered] = useState(false);
        const removeResource = useSetAtom(removeResourceAtom);
        const setPreviewedResource = useSetAtom(previewedResourceAtom);
        const togglePinResource = useSetAtom(togglePinResourceAtom);
        const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
        
        // Hover timer ref for handling delayed hover behavior
        const hoverTimerRef = useRef<number | null>(null);

        const getIconElement = (resource: Resource, isHovered: boolean) => {
            if (isHovered) {
                return (<span 
                    role="button"
                    className="resource-remove"
                    onClick={(e) => {
                        e.stopPropagation()
                        handleRemove()
                    }}
                >
                    <CSSIcon name="x-8" className="icon-16" />
                </span>)
            }
            if (resource.icon) {
                const iconElement = resource.icon ? (
                    <span className="resource-button-icon">
                        <CSSItemTypeIcon itemType={resource.icon} />
                    </span>
                ) : null
                return iconElement
            }
            return null
        }

        const handleRemove = () => {
            removeResource(resource)
        }

        // Start a timeout to close the preview after delay
        const startCloseTimer = () => {
            // Clear any existing timeout
            if (previewCloseTimeout) {
                Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
            }
            
            // Start a new timeout
            const newTimeout = Zotero.getMainWindow().setTimeout(() => {
                setPreviewedResource(null);
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
            
            // Only show preview if the resource is valid
            if (isValid) {
                hoverTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
                    setPreviewedResource(resource);
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
                setIsValid(await isResourceValid(resource));
            }
            checkAttachmentValidity();
        }, [resource])

        return (
            <button
                ref={ref}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={`resource-button ${className || ''}`}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation();
                    if (isValid) {
                        togglePinResource(resource.id);
                    }
                }}
                {...rest}
            >
                {/* {isHovered && isValid === true && attachment.type === 'zotero_item' && !pinnedItems.includes(attachment.item)
                    ? <span className="resource-button-icon"><Icon icon={PinIcon} className="icon-16" /></span>
                    : getIconElement(attachment)
                } */}
                {getIconElement(resource, isHovered)}
                <span className={!isValid ? 'font-color-red' : undefined}>
                    {resource.name}
                </span>
                {!disabled && resource.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="ml-1 -mr-1" />}
                {/* {!disabled && (
                    <span 
                        role="button"
                        className="resource-remove"
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