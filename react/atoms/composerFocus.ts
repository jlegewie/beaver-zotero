import { atom } from 'jotai';
import type { ComposerSelection } from '../utils/composerSelection';

export type ComposerSurface = 'library' | 'reader';

/**
 * One-shot handoff used when a host replaces or temporarily defocuses the
 * active composer during a view transition (for example, Zotero changing
 * between its library and reader tabs).
 */
export interface ComposerFocusTransfer {
    targetWindowToken: object;
    targetSurface: ComposerSurface;
    selection: ComposerSelection;
    deferred: boolean;
    restoreDelayMs: number;
}

export const pendingComposerFocusTransferAtom =
    atom<ComposerFocusTransfer | null>(null);
