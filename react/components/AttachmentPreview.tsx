// @ts-nocheck no idea
import React, { useRef, useEffect } from 'react';
import { Icon, PinIcon, CancelIcon, CSSItemTypeIcon } from './icons';
import { Attachment, ZoteroAttachment } from '../types/attachments';
import { useSetAtom, useAtomValue } from 'jotai';
import { previewedAttachmentAtom } from '../atoms/ui';
import { attachmentsAtom, togglePinAttachmentAtom, removeAttachmentAtom, isValidZoteroItem, updateChildItemIdsAtom } from '../atoms/attachments';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';

interface AttachmentPreviewProps {
    attachment: Attachment;
}

const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ attachment }) => {
    const previewRef = useRef<HTMLDivElement>(null);
    const setPreviewedAttachment = useSetAtom(previewedAttachmentAtom);
    const togglePinAttachment = useSetAtom(togglePinAttachmentAtom);
    const removeAttachment = useSetAtom(removeAttachmentAtom);
    const updateChildItemIds = useSetAtom(updateChildItemIdsAtom);
    const [attachments, setAttachments] = React.useState<any[]>([]);
    const [notes, setNotes] = React.useState<any[]>([]);
    const [validAttachments, setValidAttachments] = React.useState<{[id: number]: boolean}>({});

    // Read the most up-to-date version of the attachment from the attachments atom
    const attachmentsAtomValue = useAtomValue(attachmentsAtom);
    const currentAttachment = attachmentsAtomValue.find(att => att.id === attachment.id) || attachment;

    // Fetch attachments and notes when the component mounts
    useEffect(() => {
        let isMounted = true;
        
        const fetchAttachmentsAndNotes = async () => {
            if (currentAttachment.type === 'zotero_item' && currentAttachment.item) {
                // Get attachments
                const attIds = currentAttachment.item.getAttachments();
                const atts = attIds.map(id => Zotero.Items.get(id));
                if (isMounted) setAttachments(atts);

                // Check which attachments are valid
                const validityMap: {[id: number]: boolean} = {};
                for (const att of atts) {
                    try {
                        const isValid = await isValidZoteroItem(att);
                        validityMap[att.id] = isValid;
                    } catch (e) {
                        validityMap[att.id] = false;
                    }
                }
                if (isMounted) setValidAttachments(validityMap);

                // Get notes
                const noteIds = currentAttachment.item.getNotes();
                const noteItems = noteIds.map(id => Zotero.Items.get(id));
                if (isMounted) setNotes(noteItems);

                // Set best attachment as default if childItemIds is not set
                if (!currentAttachment.childItemIds && isMounted) {
                    try {
                        const bestAtt = await currentAttachment.item.getBestAttachment();
                        if (bestAtt && isMounted) {
                            updateChildItemIds({
                                attachmentId: currentAttachment.id,
                                childItemIds: [bestAtt.id.toString()]
                            });
                        }
                    } catch (e) {
                        console.error("Error getting best attachment:", e);
                    }
                }
            }
        };

        fetchAttachmentsAndNotes();
        
        return () => {
            isMounted = false;
        };
        
    }, [currentAttachment]);
    // Only run when attachment ID or type changes, not when childItemIds changes
    // }, [attachment.id, attachment.item?.id]);

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
        togglePinAttachment(currentAttachment.id);
        setPreviewedAttachment(null);
    };

    const handleRemove = () => {
        removeAttachment(currentAttachment);
        setPreviewedAttachment(null);
    };

    const handleOpen = () => {
        if (currentAttachment.type === 'zotero_item') {
            // Open in Zotero
            currentAttachment.item.select();
        }
        setPreviewedAttachment(null);
    };

    const handleToggleItem = (itemId: string) => {
        if (currentAttachment.type === 'zotero_item') {
            const currentChildItemIds = currentAttachment.childItemIds || [];
            const newChildItemIds = currentChildItemIds.includes(itemId)
                ? currentChildItemIds.filter(id => id !== itemId)
                : [...currentChildItemIds, itemId];
            
            console.log("newChildItemIds", newChildItemIds);
            updateChildItemIds({
                attachmentId: currentAttachment.id,
                childItemIds: newChildItemIds
            });
        }
    };

    const isItemSelected = (itemId: string) => {
        if (currentAttachment.type === 'zotero_item' && currentAttachment.childItemIds) {
            return currentAttachment.childItemIds.includes(itemId);
        }
        return false;
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
                    {currentAttachment.type === 'zotero_item' && (
                        <>
                            <span className="flex items-center font-color-primary">
                                {<CSSItemTypeIcon itemType={currentAttachment.item.getItemTypeIconName()} />}
                                <span className="ml-2">{currentAttachment.shortName}</span>
                            </span>
                            <p className="text-base my-2">{currentAttachment.item.getDisplayTitle()}</p>
                            
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
                                            className={validAttachments[att.id]
                                                ? `flex p-2 items-center attachment-item cursor-pointer font-color-secondary`
                                                : `flex p-2 items-center attachment-item cursor-not-allowed font-color-red`
                                            }
                                            onClick={() => validAttachments[att.id] ? handleToggleItem(att.id.toString()) : null}
                                        >
                                            <input 
                                                type="checkbox" 
                                                className="mr-2" 
                                                checked={isItemSelected(att.id.toString())}
                                                onChange={() => {}} // React requires this for controlled components
                                                disabled={!validAttachments[att.id]}
                                            />
                                            
                                            <span className="mr-1 scale-90"><CSSItemTypeIcon itemType={att.getItemTypeIconName()} /></span>
                                            {att.getDisplayTitle()}
                                            {/* <span className='font-color-red'>{att.getDisplayTitle()}</span> */}
                                        </div>
                                    ))}
                                    
                                    {/* Notes List */}
                                    {notes.map(note => (
                                        <div 
                                            key={`note-${note.id}`} 
                                            className="flex p-2 items-center attachment-item font-color-secondary cursor-pointer"
                                            onClick={() => handleToggleItem(note.id.toString())}
                                        >
                                            <input 
                                                type="checkbox" 
                                                className="mr-2" 
                                                checked={isItemSelected(note.id.toString())}
                                                onChange={() => {}} // React requires this for controlled components
                                            />
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
                    {currentAttachment.type !== 'zotero_item' && (
                        <h3>{currentAttachment.fullName}</h3>
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
                                icon={currentAttachment.pinned ? ZOTERO_ICONS.PIN_REMOVE : ZOTERO_ICONS.PIN} 
                                size={12}
                            />
                            <span>{currentAttachment.pinned ? 'Unpin' : 'Pin'}</span>
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