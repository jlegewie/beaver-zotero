// @ts-ignore no idea
import React, { useEffect, useState, forwardRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Resource } from '../types/resources'
import { useSetAtom } from 'jotai'
import { removeResourceAtom } from '../atoms/resources'
import { isResourceValid } from '../utils/resourceUtils'
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewedResourceAtom } from '../atoms/ui'

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

        useEffect(() => {
            const checkAttachmentValidity = async () => {
                setIsValid(await isResourceValid(resource));
            }
            checkAttachmentValidity();
        }, [resource])

        return (
            <button
                ref={ref}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                className={`resource-button ${className || ''}`}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation()
                    if (isValid) {
                        setPreviewedResource(resource);
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