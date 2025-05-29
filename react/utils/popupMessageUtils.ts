import { atom } from 'jotai';
import { PopupMessage } from '../types/popupMessage';
import { popupMessagesAtom } from '../atoms/ui';
import { v4 as uuidv4 } from 'uuid';
import { ZoteroItemReference } from '../types/zotero';
import { RepeatIcon } from '../components/icons/icons';
import { resetFailedUploads } from '../../src/services/FileUploader';

/**
 * Adds a new popup message to the list.
 * @param message Partial message object. ID will be generated.
 */
export const addPopupMessageAtom = atom(
    null,
    (get, set, newMessage: Omit<PopupMessage, 'id'>) => {
        const id = uuidv4();
        const messageWithDefaults: PopupMessage = {
            id,
            expire: true, // Default expire to true
            ...newMessage,
        };
        // Add to the beginning to show on top
        set(popupMessagesAtom, (prevMessages) => {
            // if (prevMessages.length > 0 && prevMessages.some((msg) => msg.text === messageWithDefaults.text && msg.title === messageWithDefaults.title)) {
            //     return prevMessages;
            // }
            return [messageWithDefaults, ...prevMessages];
        });
    }
);

export const addOrUpdateFailedUploadMessageAtom = atom(
    null,
    async (get, set, itemRef: ZoteroItemReference) => {
        const messageTitle = "File Upload Failed";
        const messages = get(popupMessagesAtom);
        const existingMessage = messages.find((msg) => msg.title?.includes(messageTitle));
        
        // Update existing message
        if (existingMessage) {
            set(popupMessagesAtom, (prevMessages) => {
                return prevMessages.map((msg) => {
                    if (msg.id == existingMessage.id) {
                        return {
                            ...msg,
                            count: msg.count ? msg.count + 1 : 1
                        };
                    }
                    return msg;
                });
            });
        // Create new message
        } else {
            // const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(itemRef.library_id, itemRef.zotero_key);
            // const zoteroItemTitle = zoteroItem?.attachmentFilename;
            set(addPopupMessageAtom, {
                type: 'error',
                title: messageTitle,
                text: `Failed to upload file(s). Please retry manually.`,
                expire: false,
                buttonIcon: RepeatIcon,
                buttonOnClick: async () => {
                    await resetFailedUploads();
                },
                count: 1
            });
        }
    }
);


/**
 * Removes a popup message by its ID.
 * @param messageId ID of the message to remove.
 */
export const removePopupMessageAtom = atom(
    null,
    (get, set, messageId: string) => {
        set(popupMessagesAtom, (prevMessages) =>
            prevMessages.filter((msg) => msg.id !== messageId)
        );
    }
);
