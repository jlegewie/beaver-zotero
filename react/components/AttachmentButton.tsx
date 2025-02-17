import React from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Attachment } from '../atoms/messages'
import { getBibliographies, getInTextCitations } from '../../src/utils/citations'

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

const getTooltip = (attachment: Attachment) => {
    if (attachment.type === 'zotero_item') {
        return getBibliographies([attachment.item])[0]
    }
    return null
}

const getLabel = (attachment: Attachment) => {
    if (attachment.type === 'zotero_item') {
        return getInTextCitations([attachment.item])[0]
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
                title={getTooltip(attachment) || ''}
                className={`attachment-button ${className || ''}`}
                disabled={disabled}
                {...rest}
            >
                {getIconElement(attachment)}
                {getLabel(attachment)}

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