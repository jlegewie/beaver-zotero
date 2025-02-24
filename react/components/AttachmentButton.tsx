// @ts-ignore no idea
import React, { useEffect, useState, forwardRef } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Attachment } from '../types/attachments'
import { useSetAtom } from 'jotai'
import { removeAttachmentAtom, togglePinAttachmentAtom, isValidAttachment } from '../atoms/attachments'
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { previewedAttachmentAtom } from '../atoms/ui'


interface AttachmentButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    attachment: Attachment
    disabled?: boolean
}

export const getIconElement = (attachment: Attachment) => {
    if (attachment.type === 'zotero_item') {
        const icon = attachment.item.getItemTypeIconName()
        const iconElement = icon ? (
            <span className="attachment-button-icon">
                <CSSItemTypeIcon itemType={icon} />
            </span>
        ) : null
        return iconElement
    }
    return null
}

export const AttachmentButton = forwardRef<HTMLButtonElement, AttachmentButtonProps>(
    function AttachmentButton(props: AttachmentButtonProps, ref: React.RefObject<HTMLButtonElement>) {
        const {
            attachment,
            className,
            disabled = false,
            ...rest
        } = props
        const [isValid, setIsValid] = useState(true);
        const removeAttachment = useSetAtom(removeAttachmentAtom);
        const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);
        const setPreviewedAttachment = useSetAtom(previewedAttachmentAtom);

        const handleRemove = () => {
            removeAttachment(attachment)
        }

        const handlePin = () => {
            togglePinAttachment(attachment.id);
        }

        useEffect(() => {
            const checkAttachmentValidity = async () => {
                setIsValid(await isValidAttachment(attachment));
            }
            checkAttachmentValidity();
        }, [attachment])

        return (
            <button
                ref={ref}
                // title={attachment.fullName}
                title={attachment.id}
                className={`attachment-button ${className || ''}`}
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation()
                    if (isValid) {
                        setPreviewedAttachment(attachment);
                    }
                }}
                {...rest}
            >
                {/* {isHovered && isValid === true && attachment.type === 'zotero_item' && !pinnedItems.includes(attachment.item)
                    ? <span className="attachment-button-icon"><Icon icon={PinIcon} className="icon-16" /></span>
                    : getIconElement(attachment)
                } */}
                {getIconElement(attachment)}
                <span className={!isValid ? 'font-color-red' : undefined}>
                    {attachment.shortName}
                </span>
                {!disabled && attachment.pinned && <ZoteroIcon icon={ZOTERO_ICONS.PIN} size={12} className="ml-1 -mr-1" />}
                {!disabled && (
                    <span 
                        role="button"
                        className="attachment-remove"
                        onClick={(e) => {
                            e.stopPropagation()
                            handleRemove()
                        }}
                    >
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                )}
            </button>
        )
    }
)