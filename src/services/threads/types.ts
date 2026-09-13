import type { ChatLoadError } from "./chatLoadError";
export interface ThreadData {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    // Zotero install identity of the device that created the thread; null for
    // unattributed threads (visible on every instance). Map these through
    // wherever ThreadData is built — a dropped field makes a foreign thread
    // masquerade as unattributed and bypass the mismatch confirm.
    zoteroUserId?: string | null;
    zoteroLocalId?: string | null;
    /**
     * Whether the user pinned this chat to the top of the history list. The
     * wire field is `starred` (backend column and route vocabulary); every
     * user-facing string says "pinned".
     */
    isPinned: boolean;
    /**
     * Agent the thread belongs to. Absent from a backend that predates the
     * field. Needed so a scoped response is not treated as authoritative about
     * another agent's threads.
     */
    agentName?: string | null;
}

export interface ThreadItemFilter {
    libraryId: number;
    libraryRef?: string; // libraryRefForLibraryID(item.libraryID)
    itemKey: string; // identity for chip + active-row checkmark
    keys: string[]; // expanded keys sent to /by-item
    itemType: string; // item.getItemTypeIconName() → CSSItemTypeIcon
    label: string; // getDisplayNameFromItem(item)
}
export interface ThreadWriteStamp {
    generation: number;
    pinSeq: number;
    revision?: number;
}
export interface PinLock {
    /** When the lock was taken, for {@link PIN_LOCK_TTL_MS}. */
    claimedAt: number;
    /**
     * Identifies the call that took it. Expiring a lock only stops others
     * waiting on it — it cannot stop the abandoned owner from coming back, so
     * that owner has to be able to tell that the lock is no longer its own
     * before it writes anything. A counter rather than the timestamp, because
     * two claims can land in the same millisecond.
     */
    token: number;
}
export type ThreadViewStatus = "idle" | "loading" | "ready" | "error";

export interface ThreadListViewState {
    /** Ids discovered for this view, in first-seen order — render sorts. */
    ids: string[];
    /** Paging cursor from the last paginated response, if any. */
    cursor: string | null;
    hasMore: boolean;
    /**
     * Threads the instance scoping hides, as reported by the backend. Only a
     * scoped first page carries one; retained across later pages and searches.
     */
    otherInstanceCount: number | null;
    /**
     * When the pinned query last ran for this view, or 0. Separate from
     * `loadedAt`: the two queries have different lifetimes, and sharing one
     * timestamp let a page reload keep the pinned query from ever re-running.
     */
    pinnedLoadedAt: number;
    status: ThreadViewStatus;
    /** A failed load must never be presented as an empty result. */
    error: ChatLoadError | null;
    /** When the view last completed a load, for the staleness check. */
    loadedAt: number;
}
