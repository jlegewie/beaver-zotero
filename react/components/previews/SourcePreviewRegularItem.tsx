import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { inputAttachmentCountAtom, updateSourceChildItemKeysAtom } from '../../atoms/input';
import { isValidZoteroItem } from '../../utils/sourceUtils';
import { CSSItemTypeIcon } from '../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../icons/ZoteroIcon';
import { truncateText } from '../../utils/stringUtils';
import { InputSource } from '../../types/sources';
import SourcePreviewHeading from './SourcePreviewHeading';
import { threadAttachmentCountAtom, userAttachmentKeysAtom } from '../../atoms/threads';
import { planFeaturesAtom } from '../../atoms/profile';
import { addPopupMessageAtom } from '../../utils/popupMessageUtils';
import { logger } from '../../../src/utils/logger';
import { getPref } from '../../../src/utils/prefs';
import { isAppKeyModelAtom } from '../../atoms/models';

interface SourcePreviewRegularItemProps {
    source: InputSource;
    item: Zotero.Item;
}

const SourcePreviewRegularItem: React.FC<SourcePreviewRegularItemProps> = ({ source, item }) => {
    const updateSourceChildItemKeys = useSetAtom(updateSourceChildItemKeysAtom);
    const [children, setChildren] = useState<Zotero.Item[]>([]);
    const [attachmentNumber, setAttachmentNumber] = useState<number>(0);
    const [noteNumber, setNoteNumber] = useState<number>(0);
    const [validItemIds, setValidItemIds] = useState<{[id: number]: boolean}>({});
    const userAttachmentKeys = useAtomValue(userAttachmentKeysAtom);
    const setPopupMessage = useSetAtom(addPopupMessageAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const isAppKeyModel = useAtomValue(isAppKeyModelAtom);
    const threadAttachmentCount = useAtomValue(threadAttachmentCountAtom);
    const inputAttachmentCount = useAtomValue(inputAttachmentCountAtom);

    // Fetch attachments and notes
    useEffect(() => {
        let isMounted = true;
        
        const fetchAttachmentsAndNotes = async () => {
            // Get children (attachments and notes)
            setAttachmentNumber(item.getAttachments().length);
            setNoteNumber(item.getNotes().length);
            const childrenIds = [...item.getAttachments(), ...item.getNotes()];
            const children = childrenIds.map(id => Zotero.Items.get(id));
            if (isMounted) setChildren(children);

            // Check which attachments are valid
            const validityMap: {[id: number]: boolean} = {};
            for (const child of children) {
                try {
                    const {valid, error} = await isValidZoteroItem(child);
                    validityMap[child.id] = valid;
                } catch (e) {
                    validityMap[child.id] = false;
                    logger(`Error checking validity of child ${child.id}: ${e}`, 2);
                }
            }
            if (isMounted) setValidItemIds(validityMap);

        };

        fetchAttachmentsAndNotes();
        
        return () => {
            isMounted = false;
        };
    }, [source]);

    const handleToggleItem = (itemKey: string) => {
        const maxUserAttachments = isAppKeyModel ? planFeatures.maxUserAttachments : getPref("maxAttachments");
        const availableAttachments = maxUserAttachments - (inputAttachmentCount + threadAttachmentCount);        
        const currentChildItemKeys = source.childItemKeys || [];
        const isCurrentlySelected = currentChildItemKeys.includes(itemKey);

        if (!isCurrentlySelected && availableAttachments <= 0) {
            setPopupMessage({
                type: 'warning',
                title: 'Attachment Limit Exceeded',
                text: `Maximum of ${maxUserAttachments} attachments reached. Remove attachments from the current message to add more.`,
                expire: true
            });
            return;
        }

        const newChildItemKeys = isCurrentlySelected
            ? currentChildItemKeys.filter(key => key !== itemKey)
            : [...currentChildItemKeys, itemKey];
        updateSourceChildItemKeys({
            sourceId: source.id,
            childItemKeys: newChildItemKeys
        });
    };

    const isItemSelected = (itemKey: string) => {
        if (source.childItemKeys) {
            return source.childItemKeys.includes(itemKey);
        }
        return false;
    };

    return (
        <>
            <SourcePreviewHeading source={source} item={item}/>                
            <p className="text-base my-2 overflow-hidden text-ellipsis">{item.getDisplayTitle()}</p>
            
            {/* Combined Attachments and Notes Section */}
            <div className="mt-3">
                <div className="display-flex items-center font-color-secondary mb-2">
                    <ZoteroIcon 
                        icon={ZOTERO_ICONS.ATTACHMENTS} 
                        size={15} 
                        color="--accent-green"
                        className="mr-2"
                    />
                    <span>{attachmentNumber} Attachment{attachmentNumber !== 1 ? 's' : ''}</span>
                    
                    <span className="mx-1"></span>
                    
                    <ZoteroIcon 
                        icon={ZOTERO_ICONS.NOTES}
                        size={15}
                        color="--accent-yellow"
                        className="mr-2"
                    />
                    <span>{noteNumber} Note{noteNumber !== 1 ? 's' : ''}</span>
                </div>
                
                <div className="ml-6 space-y-1">
                    {/* Attachments List */}
                    {children.map((child: Zotero.Item) => (
                        <div 
                            key={`att-${child.id}`}
                            className={validItemIds[child.id]
                                ? `display-flex p-2 items-center attachment-item cursor-pointer font-color-secondary ${userAttachmentKeys.includes(child.key) ? 'opacity-60 cursor-not-allowed' : ''}`
                                : `display-flex p-2 items-center attachment-item cursor-not-allowed font-color-red`
                            }
                            onClick={() => validItemIds[child.id] && !userAttachmentKeys.includes(child.key) ? handleToggleItem(child.key) : null}
                        >
                            <input 
                                type="checkbox" 
                                className="mr-2"
                                checked={isItemSelected(child.key)}
                                onChange={() => {}} // React requires this for controlled components
                                disabled={!validItemIds[child.id] || userAttachmentKeys.includes(child.key)}
                            />
                            
                            <span className="mr-1 fit-content">
                                <CSSItemTypeIcon className="scale-85" itemType={child.getItemTypeIconName()} />
                            </span>
                            {truncateText(child.getDisplayTitle(), 32)}
                        </div>
                    ))}
                    
                    {/* Show message if no attachments or notes */}
                    {attachmentNumber === 0 && noteNumber === 0 && (
                        <div className="text-gray-400 italic">No attachments or notes</div>
                    )}
                </div>
            </div>
        </>
    );
};

export default SourcePreviewRegularItem; 