// @ts-nocheck no idea
import React, { useRef, useEffect } from 'react';
import { Icon, PinIcon, CancelIcon } from './icons';
import { Attachment } from '../types/attachments';
import { useAtom } from 'jotai';
import { previewedContextItemAtom } from '../atoms/ui';
import { togglePinAttachmentAtom, removeAttachmentAtom } from '../atoms/attachments';
import { useSetAtom } from 'jotai';

interface ContextItemPreviewProps {
    attachment: Attachment;
}

const ContextItemPreview: React.FC<ContextItemPreviewProps> = ({ attachment }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const [_, setpreviewedContextItem] = useAtom(previewedContextItemAtom);
    const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);
    const removeAttachment = useSetAtom(removeAttachmentAtom);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setpreviewedContextItem(null);
            }
        };

        const handleClickOutside = (e: MouseEvent) => {
            if (previewRef.current && !previewRef.current.contains(e.target as Node)) {
                setpreviewedContextItem(null);
            }
        };

        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);
        Zotero.getMainWindow().document.addEventListener('mousedown', handleClickOutside);

        return () => {
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
            Zotero.getMainWindow().document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [setpreviewedContextItem]);

    const handlePin = () => {
        togglePinAttachment(attachment.id);
        setpreviewedContextItem(null);
    };

    const handleRemove = () => {
        removeAttachment(attachment);
        setpreviewedContextItem(null);
    };

    const handleOpen = () => {
        if (attachment.type === 'zotero_item') {
            // Open in Zotero
            attachment.item.select();
        }
        setpreviewedContextItem(null);
    };

    return (
        <div
            ref={previewRef}
            className="attachment-preview mx-0"
        >
            <div className="flex flex-col gap-3">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <h3 className="font-medium">{attachment.shortName}</h3>
                    <button 
                        className="icon-button"
                        onClick={() => setpreviewedContextItem(null)}
                    >
                        <Icon icon={CancelIcon} />
                    </button>
                </div>

                {/* Actions */}
                <div className="flex flex-row items-center pt-2">
                    <div className="flex-1" />
                    <div className="flex gap-3">
                        <button
                            className="beaver-button"
                            onClick={handlePin}
                        >
                            <Icon icon={PinIcon} />
                            {attachment.pinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button
                            className="beaver-button"
                            onClick={handleOpen}
                        >
                            {/* <Icon icon={ExternalLinkIcon} /> */}
                            Open
                        </button>
                        <button 
                            className="beaver-button"
                            onClick={handleRemove}
                        >
                            Remove
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ContextItemPreview;
