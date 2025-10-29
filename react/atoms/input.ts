import { atom } from "jotai";
import { TextSelection } from '../types/attachments/apiTypes';

/**
* Current library IDs
* Search will be limited to these libraries. Currently only supporting single library.
* Array is used to support multiple libraries in the future. Empty array means all libraries.
*/
export const currentLibraryIdsAtom = atom<number[]>([]);

/**
* Remove a library from the current selection
*/
export const removeLibraryIdAtom = atom(
    null,
    (get, set, libraryId: number) => {
        const currentIds = get(currentLibraryIdsAtom);
        set(currentLibraryIdsAtom, currentIds.filter(id => id !== libraryId));
    }
);

/**
* Current user message and sources
*/
export const currentMessageContentAtom = atom<string>('');

/**
 * Current reader text selection
*/
export const readerTextSelectionAtom = atom<TextSelection | null>(null);