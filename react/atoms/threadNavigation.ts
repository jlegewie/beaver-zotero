import { atom } from 'jotai';

/**
 * Counts chat navigations in this window, so work the window started for
 * one chat (preparing a message, loading history) can tell it has been left
 * behind.
 */
export const threadNavigationSeqAtom = atom(0);
