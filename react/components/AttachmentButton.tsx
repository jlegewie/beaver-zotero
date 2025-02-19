import React from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Attachment } from '../types/attachments'

interface AttachmentButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    attachment: Attachment
    onRemove?: () => void
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
            onRemove,
            className,
            disabled = false,
            ...rest
        } = props

        return (
            <button
                ref={ref}
                title={attachment.fullName}
                className={`attachment-button ${className || ''}`}
                disabled={disabled}
                {...rest}
            >
                {getIconElement(attachment)}
                <span className={attachment.valid ? undefined : 'color-red'}>
                    {attachment.shortName}
                </span>

                {onRemove && !disabled && (
                    <span 
                        role="button"
                        className="attachment-remove"
                        onClick={(e) => {
                            e.stopPropagation()
                            onRemove()
                        }}
                    >
                        <CSSIcon name="x-8" className="icon-16" />
                    </span>
                )}
            </button>
        )
    }
)