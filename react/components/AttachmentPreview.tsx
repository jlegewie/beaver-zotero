// @ts-nocheck no idea
import React, { useRef, useEffect } from 'react';
import { Icon, PinIcon, CancelIcon, CSSItemTypeIcon } from './icons';
import { Attachment } from '../types/attachments';
import { useSetAtom } from 'jotai';
import { previewedAttachmentAtom } from '../atoms/ui';
import { togglePinAttachmentAtom, removeAttachmentAtom, isValidAttachment } from '../atoms/attachments';
import { AttachmentButton, getIconElement } from './AttachmentButton';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';

interface AttachmentPreviewProps {
    attachment: Attachment;
}

const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ attachment }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewedAttachment = useSetAtom(previewedAttachmentAtom);
    const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);
    const removeAttachment = useSetAtom(removeAttachmentAtom);
    const [attachments, setAttachments] = React.useState<any[]>([]);
    const [notes, setNotes] = React.useState<any[]>([]);
    const [validAttachments, setValidAttachments] = React.useState<{[id: number]: boolean}>({});
    const [bestAttachmentId, setBestAttachmentId] = React.useState<number | null>(null);

    // Fetch attachments and notes when the component mounts
    useEffect(() => {
        const fetchAttachmentsAndNotes = async () => {
            if (attachment.type === 'zotero_item' && attachment.item) {
                // Get attachments
                const attIds = attachment.item.getAttachments();
                const atts = attIds.map(id => Zotero.Items.get(id));
                setAttachments(atts);

                // Check which attachments are valid
                const validityMap: {[id: number]: boolean} = {};
                for (const att of atts) {
                    try {
                        const isValid = await isValidAttachment(att);
                        validityMap[att.id] = isValid;
                    } catch (e) {
                        validityMap[att.id] = false;
                    }
                }
                setValidAttachments(validityMap);

                // Get best attachment
                try {
                    const bestAtt = await attachment.item.getBestAttachment();
                    if (bestAtt) {
                        setBestAttachmentId(bestAtt.id);
                    }
                } catch (e) {
                    console.error("Error getting best attachment:", e);
                }

                // Get notes
                const noteIds = attachment.item.getNotes();
                const noteItems = noteIds.map(id => Zotero.Items.get(id));
                setNotes(noteItems);
            }
        };

        fetchAttachmentsAndNotes();
    }, [attachment]);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setPreviewedAttachment(null);
            }
        };

        const handleClickOutside = (e: MouseEvent) => {
            if (previewRef.current && !previewRef.current.contains(e.target as Node)) {
                setPreviewedAttachment(null);
            }
        };

        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);
        Zotero.getMainWindow().document.addEventListener('mousedown', handleClickOutside);

        return () => {
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
            Zotero.getMainWindow().document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [setPreviewedAttachment]);

    const handlePin = () => {
        togglePinAttachment(attachment.id);
        setPreviewedAttachment(null);
    };

    const handleRemove = () => {
        removeAttachment(attachment);
        setPreviewedAttachment(null);
    };

    const handleOpen = () => {
        if (attachment.type === 'zotero_item') {
            // Open in Zotero
            attachment.item.select();
        }
        setPreviewedAttachment(null);
    };

    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3">
            <div
                ref={previewRef}
                className="attachment-preview mx-0"
                // style={{ backgroundColor: 'rgba(255, 0, 0, 0.2)' }}
            >
                {/* Content Area */}
                <div className="attachment-content p-3">
                    {attachment.type === 'zotero_item' && (
                        <>
                            <span className="flex items-center font-color-primary">
                                {getIconElement(attachment)}
                                {attachment.shortName}
                            </span>
                            <p className="text-base m-2">{attachment.item.getDisplayTitle()}</p>
                            
                            {/* Combined Attachments and Notes Section */}
                            <div className="mt-3">
                                <div className="flex items-center font-color-secondary mb-2">
                                    <ZoteroIcon 
                                        icon={ZOTERO_ICONS.ATTACHMENTS} 
                                        size={15} 
                                        color="--accent-green"
                                        className="mr-2"
                                    />
                                    <span>{attachments.length} Attachment{attachments.length !== 1 ? 's' : ''}</span>
                                    
                                    <span className="mx-1"></span>
                                    
                                    <ZoteroIcon 
                                        icon={ZOTERO_ICONS.NOTES}
                                        size={15}
                                        color="--accent-yellow"
                                        className="mr-2"
                                    />
                                    <span>{notes.length} Note{notes.length !== 1 ? 's' : ''}</span>
                                </div>
                                
                                <div className="ml-6 space-y-1">
                                    {/* Attachments List */}
                                    {attachments.map(att => (
                                        <div 
                                            key={`att-${att.id}`}
                                            className={`flex p-2 items-center attachment-item ${validAttachments[att.id] ? 'font-color-secondary' : 'font-color-red'}`}
                                        >
                                            <input 
                                                type="checkbox" 
                                                className="mr-2" 
                                                defaultChecked={att.id === bestAttachmentId}
                                            />
                                            <span className="mr-1 scale-90"><CSSItemTypeIcon itemType={att.getItemTypeIconName()} /></span>
                                            {att.getDisplayTitle()}
                                            {/* {att.id === bestAttachmentId && <span className="ml-2 text-sm font-color-green">Best</span>} */}
                                        </div>
                                    ))}
                                    
                                    {/* Notes List */}
                                    {notes.map(note => (
                                        <div 
                                            key={`note-${note.id}`} 
                                            className="flex p-2 items-center attachment-item font-color-secondary"
                                        >
                                            <input type="checkbox" className="mr-2" />
                                            <span className="mr-1 scale-90"><CSSItemTypeIcon itemType={note.getItemTypeIconName()} /></span>
                                            {note.getNoteTitle()}
                                        </div>
                                    ))}
                                    
                                    {/* Show message if no attachments or notes */}
                                    {attachments.length === 0 && notes.length === 0 && (
                                        <div className="text-gray-400 italic">No attachments or notes</div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                    {attachment.type !== 'zotero_item' && (
                        <h3>{attachment.fullName}</h3>
                    )}
                </div>

                {/* buttons */}
                <div className="p-1 flex flex-row items-center">
                    <div className="flex-1 gap-4">
                        <button
                            className="attachment-ghost-button"
                            onClick={handlePin}
                        >
                            {/* <Icon icon={PinIcon} /> */}
                            <ZoteroIcon 
                                icon={attachment.pinned ? ZOTERO_ICONS.PIN_REMOVE : ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{attachment.pinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                        <button
                            className="attachment-ghost-button"
                            onClick={handleOpen}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.OPEN} 
                                size={12}
                            />
                            Open
                        </button>
                        <button 
                            className="attachment-ghost-button"
                            onClick={handleRemove}
                        >
                            <ZoteroIcon 
                                icon={ZOTERO_ICONS.TRASH} 
                                size={12}
                            />
                            Remove
                        </button>
                    </div>
                    <div className="flex">
                        <button
                            className="attachment-ghost-button"
                            onClick={() => setPreviewedAttachment(null)}
                        >
                            <Icon icon={CancelIcon} />
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
};

export default AttachmentPreview;