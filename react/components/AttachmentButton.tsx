import React, { useEffect, useState } from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Attachment } from '../types/attachments'
import { useSetAtom } from 'jotai'
import { removeAttachmentAtom, togglePinAttachmentAtom, isValidAttachment } from '../atoms/attachments'
import { PinIcon, Icon } from './icons'


interface AttachmentButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    attachment: Attachment
    disabled?: boolean
}

const getIconElement = (attachment: Attachment) => {
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

export const AttachmentButton = React.forwardRef<HTMLButtonElement, AttachmentButtonProps>(
    function AttachmentButton(props, ref) {
        const {
            attachment,
            className,
            disabled = false,
            ...rest
        } = props
        const [isValid, setIsValid] = useState(true);
        const [isHovered, setIsHovered] = useState(false);
        const removeAttachment = useSetAtom(removeAttachmentAtom);
        const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);

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
                className={`attachment-button ${className || ''} ${attachment.pinned ? 'pinned' : ''}`}
                disabled={disabled}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                onClick={(e) => {
                    e.stopPropagation()
                    if (isValid) handlePin()
                }}
                {...rest}
            >
                {/* {isHovered && isValid === true && attachment.type === 'zotero_item' && !pinnedItems.includes(attachment.item)
                    ? <span className="attachment-button-icon"><Icon icon={PinIcon} className="icon-16" /></span>
                    : getIconElement(attachment)
                } */}
                {getIconElement(attachment)}
                <span className={!isValid ? 'color-red' : undefined}>
                    {attachment.shortName}
                </span>
                {!disabled && attachment.pinned && <Icon icon={PinIcon} className="icon-16 -mr-1" />}

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