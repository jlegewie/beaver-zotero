import { atom } from 'jotai';
import { PopupMessage } from '../types/popupMessage';
import { v4 as uuidv4 } from 'uuid';

/**
 * Floating popup messages that render over the main Zotero window,
 * independent of the sidebar. Used for version announcements,
 * notifications when sidebar is closed, etc.
 */
export const floatingPopupMessagesAtom = atom<PopupMessage[]>([]);

/**
 * Adds a new floating popup message.
 * ID will be generated if not provided. Deduplicates by ID.
 */
export const addFloatingPopupMessageAtom = atom(
    null,
    (get, set, newMessage: Omit<PopupMessage, 'id'> & { id?: string }) => {
        const id = newMessage.id ?? uuidv4();
        const messageWithDefaults: PopupMessage = {
            id,
            expire: true,
            ...newMessage,
        };
        set(floatingPopupMessagesAtom, (prevMessages) => {
            const withoutDuplicate = prevMessages.filter((msg) => msg.id !== id);
            return [messageWithDefaults, ...withoutDuplicate];
        });
    }
);

/**
 * Removes a floating popup message by its ID.
 */
export const removeFloatingPopupMessageAtom = atom(
    null,
    (get, set, messageId: string) => {
        set(floatingPopupMessagesAtom, (prevMessages) =>
            prevMessages.filter((msg) => msg.id !== messageId)
        );
    }
);

/**
 * Removes all floating popup messages of a given type.
 */
export const removeFloatingPopupMessagesByTypeAtom = atom(
    null,
    (get, set, type: PopupMessage['type']) => {
        set(floatingPopupMessagesAtom, (prevMessages) =>
            prevMessages.filter((msg) => msg.type !== type)
        );
    }
);
