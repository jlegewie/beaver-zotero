import { atom } from 'jotai';
import { PopupMessage } from '../types/popupMessage';
import { popupMessagesAtom } from '../atoms/ui';
import { v4 as uuidv4 } from 'uuid';
import { ZoteroItemReference } from '../types/zotero';
import { RepeatIcon } from '../components/icons/icons';
import { retryUploadsByStatus } from '../../src/services/FileUploader';

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

export type PopupMessageUpdates = Partial<Omit<PopupMessage, 'id'>>;

/**
 * Updates a popup message by its ID.
 * @param messageId ID of the message to update.
 * @param updates Partial message object with fields to update.
 */
export const updatePopupMessageAtom = atom(
    null,
    (
        get,
        set,
        {
            messageId,
            updates,
        }: {
            messageId: string;
            updates: PopupMessageUpdates;
        },
    ) => {
        set(popupMessagesAtom, (prevMessages) =>
            prevMessages.map((msg) =>
                msg.id === messageId ? { ...msg, ...updates } : msg,
            ),
        );
    },
);

export const addOrUpdateFailedUploadMessageAtom = atom(
    null,
    async (get, set, itemRef: ZoteroItemReference) => {
        const messageTitle = "File Upload Failed";
        const messages = get(popupMessagesAtom);
        const existingMessage = messages.find((msg) => msg.title?.includes(messageTitle));
        
        // Update existing message
        if (existingMessage) {
            set(updatePopupMessageAtom, {
                messageId: existingMessage.id,
                updates: {
                    count: (existingMessage.count || 0) + 1,
                },
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
                    await retryUploadsByStatus("failed");
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

/**
 * Adds or updates an API key popup message.
 * If an API key message already exists, updates it with the new provider.
 * Otherwise, creates a new message.
 * 
 * @param provider The provider type (google, openai, anthropic)
 * @param providerDisplayName The display name (e.g., "Google Gemini", "OpenAI")
 * @param hasStreamingIssue Whether OpenAI requires verification
 * @param currentModelUsesAppKey Whether the current model uses Beaver's key
 * @param currentModelName The name of the current model (if using app key)
 */
export const addAPIKeyMessageAtom = atom(
    null,
    (get, set, {
        provider,
        providerDisplayName,
        hasStreamingIssue,
        currentModelUsesAppKey,
        currentModelName
    }: {
        provider: string;
        providerDisplayName: string;
        hasStreamingIssue: boolean;
        currentModelUsesAppKey: boolean;
        currentModelName?: string;
    }) => {
        const messages = get(popupMessagesAtom);
        // Look for any message with "API Key" in the title
        const existingMessage = messages.find((msg) => msg.title?.includes('API Key'));

        // Build the provider list and special notes
        let providers: string[] = [];
        let streamingNote = '';
        let appKeyNote = '';
        let existingMessageId: string | undefined;

        if (existingMessage && existingMessage.title) {
            existingMessageId = existingMessage.id;
            
            // Extract existing providers from the title
            // Match patterns like "OpenAI API Key Added" or "OpenAI and Claude API Keys Added"
            const titleMatch = existingMessage.title.match(/^(.+?) API Keys? Added$/);
            if (titleMatch) {
                // Split by "and" or ", " to get individual providers
                const providerText = titleMatch[1];
                providers = providerText.split(/ and |, /).map(p => p.trim());
            }
            
            // Keep existing streaming note if present
            if (existingMessage.text?.includes('Verification required:')) {
                streamingNote = '\n\nVerification required: Visit OpenAI Organization Settings to verify your organization before using OpenAI key.';
            }
            
            // Keep existing app key note if present
            const appKeyMatch = existingMessage.text?.match(/The current model \((.+?)\) uses Beaver's key/);
            if (appKeyMatch) {
                appKeyNote = `\n\nThe current model (${appKeyMatch[1]}) uses Beaver's key. To use your own, pick a model under 'Your API Keys'.`;
            }
        }

        // Add new provider if not already in list
        if (!providers.includes(providerDisplayName)) {
            providers.push(providerDisplayName);
        }

        // Update streaming note if this is OpenAI with issues
        if (provider === 'openai' && hasStreamingIssue) {
            streamingNote = '\n\nVerification required: Visit OpenAI Organization Settings to verify your organization before using this key.';
        }

        // Update app key note with current state
        if (currentModelUsesAppKey && currentModelName) {
            appKeyNote = `\n\nThe current model (${currentModelName}) uses Beaver's key. To use your own, pick a model under 'Your API Keys'.`;
        } else {
            appKeyNote = ''; // Clear if no longer using app key
        }

        // Format provider list for display
        const formatProviderList = (providers: string[]): string => {
            if (providers.length === 1) return providers[0];
            if (providers.length === 2) return providers.join(' and ');
            const last = providers[providers.length - 1];
            const rest = providers.slice(0, -1);
            return `${rest.join(', ')}, and ${last}`;
        };

        const formattedProviders = formatProviderList(providers);
        const isPlural = providers.length > 1;
        
        // Build title and text
        const title = `${formattedProviders} API Key${isPlural ? 's' : ''} Added`;
        let messageText = `You can now select ${formattedProviders} models from the model selector.`;
        messageText += streamingNote;
        messageText += appKeyNote;

        if (existingMessage && existingMessageId) {
            // Update existing message
            set(updatePopupMessageAtom, {
                messageId: existingMessageId,
                updates: {
                    title: title,
                    text: messageText
                }
            });
        } else {
            // Create new message
            set(addPopupMessageAtom, {
                type: 'info',
                title: title,
                text: messageText,
                expire: false
            });
        }
    }
);
