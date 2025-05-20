import { atom } from 'jotai';
import { PopupMessage } from '../types/popupMessage';
import { popupMessagesAtom } from '../atoms/ui';
import { v4 as uuidv4 } from 'uuid';

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
        set(popupMessagesAtom, (prevMessages) => [messageWithDefaults, ...prevMessages]);
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
