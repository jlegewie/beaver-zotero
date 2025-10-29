import { atom } from 'jotai';
import { createElement } from 'react';
import { PopupMessage } from '../types/popupMessage';
import { popupMessagesAtom } from '../atoms/ui';
import { v4 as uuidv4 } from 'uuid';
import { ZoteroItemReference } from '../types/zotero';
import { RepeatIcon, CSSItemTypeIcon } from '../components/icons/icons';
import { retryUploads } from '../../src/services/FileUploader';
import { RegularItemMessageContent } from '../components/ui/popup/RegularItemMessageContent';
import { RegularItemsSummaryContent } from '../components/ui/popup/RegularItemsSummaryContent';
import { truncateText } from '../utils/stringUtils';
import { getDisplayNameFromItem } from '../utils/sourceUtils';
import type { ItemValidationState } from '../atoms/itemValidation';
import { buildMessageItemSummary } from '../hooks/useMessageItemSummary';

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
                    await retryUploads();
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

const parseProvidersFromTitle = (title: string): string[] => {
    const match = title.match(/^(.+?) API Keys? Added$/);
    if (!match) {
        return [];
    }

    const normalized = match[1]
        .replace(/,\s+and\s+/g, ', ')
        .replace(/\s+and\s+/g, ', ');

    const providerList = normalized
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

    return Array.from(new Set(providerList));
};

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
        const existingMessage = messages.find((msg) => msg.title?.includes('API Key'));

        let streamingNote = '';
        let appKeyNote = '';
        let existingMessageId: string | undefined;
        const providerSet = new Set<string>();

        if (existingMessage) {
            existingMessageId = existingMessage.id;

            if (existingMessage.title) {
                parseProvidersFromTitle(existingMessage.title).forEach((name) => providerSet.add(name));
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
        if (!providerSet.has(providerDisplayName)) {
            providerSet.add(providerDisplayName);
        }
        const providers = Array.from(providerSet);

        // Update streaming note if this is OpenAI with issues
        if (provider === 'openai' && hasStreamingIssue) {
            streamingNote = '\n\nVerification required: Visit OpenAI Organization Settings to verify your organization before using this key.';
        }

        // Update app key note with current state
        if (currentModelUsesAppKey && currentModelName) {
            appKeyNote = `\n\nThe current model (${currentModelName}) uses Beaver's key. To use your own, pick a model under 'Your API Keys'.`;
        } else {
            appKeyNote = '';
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

/**
 * Adds a popup message for a regular item showing its attachment status.
 * Always shows popup; duration is longer if there are issues (no PDF or invalid attachments).
 * 
 * @param item The regular Zotero item
 * @param getValidation Function to get validation results for items
 */
export const addRegularItemPopupAtom = atom(
    null,
    (get, set, { 
        item, 
        getValidation 
    }: { 
        item: Zotero.Item; 
        getValidation: (item: Zotero.Item) => ItemValidationState | undefined;
    }) => {
        const summary = buildMessageItemSummary(item, getValidation);

        // Always show popup for regular items
        set(addPopupMessageAtom, {
            type: 'info',
            icon: createElement(CSSItemTypeIcon, { itemType: item.getItemTypeIconName() }),
            title: truncateText(getDisplayNameFromItem(item), 68),
            customContent: createElement(RegularItemMessageContent, { 
                item,
                summary
            }),
            expire: true,
            duration: summary.hasIssues ? 4000 : 3000
        });
    }
);

/**
 * Adds a summary popup message for multiple regular items showing their attachment status.
 * 
 * @param items Array of regular Zotero items
 * @param getValidation Function to get validation results for items
 */
export const addRegularItemsSummaryPopupAtom = atom(
    null,
    (get, set, { 
        items, 
        getValidation 
    }: { 
        items: Zotero.Item[]; 
        getValidation: (item: Zotero.Item) => ItemValidationState | undefined;
    }) => {
        // Build summary data for each item
        const itemsSummary = items.map(item => {
            const summary = buildMessageItemSummary(item, getValidation);
            
            return {
                item,
                totalAttachments: summary.validAttachmentCount,
                invalidAttachments: summary.invalidAttachmentCount
            };
        });

        // Determine if there are any issues
        const hasIssues = itemsSummary.some(summary => 
            summary.totalAttachments === 0 || summary.invalidAttachments > 0
        );

        // Show summary popup
        set(addPopupMessageAtom, {
            type: 'info',
            title: `${items.length} Items Added`,
            customContent: createElement(RegularItemsSummaryContent, { 
                items: itemsSummary 
            }),
            expire: true,
            duration: hasIssues ? 4000 : 3000
        });
    }
);
