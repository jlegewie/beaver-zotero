import React from 'react'
import { CSSItemTypeIcon, CSSIcon } from "./icons"
import { Attachment } from '../types/attachments'
import { useSetAtom } from 'jotai'
import { removedItemKeysAtom, selectedItemsAtom, localFilesAtom, pinnedItemsAtom } from '../atoms/attachments'


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
        const setRemovedItemKeys = useSetAtom(removedItemKeysAtom);
        const setLocalFiles = useSetAtom(localFilesAtom);
        const setPinnedItems = useSetAtom(pinnedItemsAtom);

        const handleRemove = () => {
            if (attachment.type === 'zotero_item') {
                setRemovedItemKeys((prev) => [...prev, attachment.item.key])
                setPinnedItems((prev) => prev.filter((item) => item.key !== attachment.item.key))
                // setSelectedItems((prev) => prev.filter((item) => item.key !== attachment.item.key))
            }
            if (attachment.type === 'file') {
                setLocalFiles((prev) => prev.filter((file) => file.name !== attachment.filePath))
            }
        }

        return (
            <button
                ref={ref}
                title={attachment.fullName}
                className={`attachment-button ${className || ''}`}
                disabled={disabled}
                {...rest}
            >
                {getIconElement(attachment)}
                <span className={attachment.valid === false ? 'color-red' : undefined}>
                    {attachment.shortName}
                </span>

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