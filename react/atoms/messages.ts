import { atom } from "jotai";

// Message types
export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string | ContentPart[];
}

// Content parts
export type ContentPart = ContentPartText | ContentPartZoteroItem | ContentPartImage;

export type ContentPartText = {
    type: 'text';
    text: string;
}

export type ContentPartImage = {
    type: 'image';
    image_url: string;
}

export type ContentPartZoteroItem = {
    type: 'zotero_item';
    item: Zotero.Item;
}

// Current user message and content parts
export const userMessageAtom = atom<string>('');
export const userContentPartsAtom = atom<ContentPart[]>([]);

// Messages atom
export const messagesAtom = atom<ChatMessage[]>([]);

// Derived atoms
export const systemMessageAtom = atom((get) => {
    const messages = get(messagesAtom);
    return messages.find((message) => message.role === 'system')?.content;
});