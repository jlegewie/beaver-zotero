import { atom } from "jotai";

// Message types
export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
    attachments?: Attachment[];
}

// Attachment types
export type ZoteroAttachment = {
    type: 'zotero_item';
    item: Zotero.Item;
}

export type ImageAttachment = {
    type: 'image';
    image_url: string;
}

export type Attachment = ZoteroAttachment | ImageAttachment;


// Current user message and content parts
export const userMessageAtom = atom<string>('');
export const userAttachmentsAtom = atom<Attachment[]>([]);

// Messages atom
export const messagesAtom = atom<ChatMessage[]>([]);

// Derived atoms
export const systemMessageAtom = atom((get) => {
    const messages = get(messagesAtom);
    return messages.find((message) => message.role === 'system')?.content;
});








// messages = [
//     {"role": "system", "content": system_message},
//     {
//         "role": "user", 
//         "content": [
//             {
//                 "type": "image_url",
//                 "image_url": {"url": f"data:image/png;base64,{image_base64}"}
//             },
//             {"role": "user", "content": "This is my image"}
//         ]
//     },
//     {"role": "user", "content": "test"},
// ]