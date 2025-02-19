import { atom } from 'jotai';

export const isAiSidebarVisibleAtom = atom(false);
export const selectedItemsAtom = atom<Zotero.Item[]>([]);