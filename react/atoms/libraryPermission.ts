import { atom } from 'jotai';

/**
 * How much Beaver may change in the library on its own.
 *
 * `ask` defers to the per-tool preferences the user configured in Settings —
 * some groups apply on their own, others raise an approval card. `full_access`
 * is a standing grant that applies every agent action without asking, as if
 * every one of those preferences were set to "Always apply".
 */
export type LibraryPermissionMode = 'ask' | 'full_access';

/**
 * The composer's permission mode.
 *
 * Deliberately not persisted to prefs: this is a standing grant to write to the
 * user's library, so it lasts the Zotero session and starts over at `ask`.
 * A user who wants a permanent grant sets the per-tool preferences in Settings,
 * which carry their own safety carve-outs.
 *
 * The store is shared across every mount point, so the main window, the reader
 * pane and the separate Beaver window all read and write the same mode.
 */
export const libraryPermissionModeAtom = atom<LibraryPermissionMode>('ask');

/** True while the standing grant is in force. */
export const hasFullLibraryAccessAtom = atom(
    (get) => get(libraryPermissionModeAtom) === 'full_access',
);
