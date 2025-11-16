import { atom } from 'jotai';

/**
 * Shared UI atoms keep view state (expansion toggles, busy flags, etc.)
 * consistent between the library and reader panes. All keys follow a
 * `messageId[:toolOrGroupId]` pattern so they can be cleaned up easily.
 */

type BooleanMap = Record<string, boolean>;

type AnnotationPanelState = {
    resultsVisible: boolean;
    isApplying: boolean;
};

type AnnotationPanelStateMap = Record<string, AnnotationPanelState>;
type AnnotationBusyStateMap = Record<string, Record<string, boolean>>;
type AnnotationAttachmentTitleMap = Record<string, string | null>;

export const defaultAnnotationPanelState: AnnotationPanelState = {
    resultsVisible: true,
    isApplying: false
};

/**
 * Utility helpers to drop per-message entries when a thread is cleared.
 */
const removeEntriesWithPrefix = <T extends Record<string, unknown>>(map: T, prefix: string) => {
    const next = { ...map } as T;
    Object.keys(next).forEach((key) => {
        if (key.startsWith(prefix)) {
            delete next[key];
        }
    });
    return next;
};

const removeEntry = <T extends Record<string, unknown>>(map: T, keyToRemove: string) => {
    const next = { ...map } as T;
    delete next[keyToRemove];
    return next;
};

// ---------------------------------------------------------------------------
// Search tool call UI
// ---------------------------------------------------------------------------
export const searchToolVisibilityAtom = atom<BooleanMap>({});

export const toggleSearchToolVisibilityAtom = atom(
    null,
    (get, set, key: string) => {
        const current = get(searchToolVisibilityAtom);
        const next = !(current[key] ?? false);
        set(searchToolVisibilityAtom, { ...current, [key]: next });
    }
);

export const setSearchToolVisibilityAtom = atom(
    null,
    (get, set, { key, visible }: { key: string; visible: boolean }) => {
        const current = get(searchToolVisibilityAtom);
        set(searchToolVisibilityAtom, { ...current, [key]: visible });
    }
);

// ---------------------------------------------------------------------------
// Sources + thinking sections on assistant messages
// ---------------------------------------------------------------------------
export const messageSourcesVisibilityAtom = atom<BooleanMap>({});
export const thinkingVisibilityAtom = atom<BooleanMap>({});

export const toggleMessageSourcesVisibilityAtom = atom(
    null,
    (get, set, messageId: string) => {
        const current = get(messageSourcesVisibilityAtom);
        const next = !(current[messageId] ?? false);
        set(messageSourcesVisibilityAtom, { ...current, [messageId]: next });
    }
);

export const setMessageSourcesVisibilityAtom = atom(
    null,
    (get, set, { messageId, visible }: { messageId: string; visible: boolean }) => {
        const current = get(messageSourcesVisibilityAtom);
        set(messageSourcesVisibilityAtom, { ...current, [messageId]: visible });
    }
);

export const toggleThinkingVisibilityAtom = atom(
    null,
    (get, set, messageId: string) => {
        const current = get(thinkingVisibilityAtom);
        const next = !(current[messageId] ?? false);
        set(thinkingVisibilityAtom, { ...current, [messageId]: next });
    }
);

export const setThinkingVisibilityAtom = atom(
    null,
    (get, set, { messageId, visible }: { messageId: string; visible: boolean }) => {
        const current = get(thinkingVisibilityAtom);
        set(thinkingVisibilityAtom, { ...current, [messageId]: visible });
    }
);

// ---------------------------------------------------------------------------
// Annotation groups (button + busy states)
// ---------------------------------------------------------------------------
export const annotationPanelStateAtom = atom<AnnotationPanelStateMap>({});
export const annotationBusyAtom = atom<AnnotationBusyStateMap>({});
export const annotationAttachmentTitlesAtom = atom<AnnotationAttachmentTitleMap>({});

export const setAnnotationPanelStateAtom = atom(
    null,
    (get, set, { key, updates }: { key: string; updates: Partial<AnnotationPanelState> }) => {
        const current = get(annotationPanelStateAtom);
        const existing = current[key] ?? defaultAnnotationPanelState;
        set(annotationPanelStateAtom, { ...current, [key]: { ...existing, ...updates } });
    }
);

export const toggleAnnotationPanelVisibilityAtom = atom(
    null,
    (get, set, key: string) => {
        const current = get(annotationPanelStateAtom);
        const existing = current[key] ?? defaultAnnotationPanelState;
        set(annotationPanelStateAtom, { ...current, [key]: { ...existing, resultsVisible: !existing.resultsVisible } });
    }
);

/**
 * Tracks spinner/busy flags for individual proposed actions so both panes show
 * which annotation is being processed.
 */
export const setAnnotationBusyStateAtom = atom(
    null,
    (get, set, { key, annotationId, isBusy }: { key: string; annotationId: string; isBusy: boolean }) => {
        const current = get(annotationBusyAtom);
        const existing = current[key] ?? {};
        set(annotationBusyAtom, { ...current, [key]: { ...existing, [annotationId]: isBusy } });
    }
);

export const setAnnotationAttachmentTitleAtom = atom(
    null,
    (get, set, { key, title }: { key: string; title: string | null }) => {
        const current = get(annotationAttachmentTitlesAtom);
        set(annotationAttachmentTitlesAtom, { ...current, [key]: title });
    }
);

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------
export const resetMessageUIStateAtom = atom(
    null,
    (_get, set) => {
        set(searchToolVisibilityAtom, {});
        set(messageSourcesVisibilityAtom, {});
        set(thinkingVisibilityAtom, {});
        set(annotationPanelStateAtom, {});
        set(annotationBusyAtom, {});
        set(annotationAttachmentTitlesAtom, {});
    }
);

export const clearMessageUIStateAtom = atom(
    null,
    (get, set, messageId: string) => {
        const prefix = `${messageId}:`;
        set(searchToolVisibilityAtom, removeEntriesWithPrefix(get(searchToolVisibilityAtom), prefix));
        set(annotationPanelStateAtom, removeEntriesWithPrefix(get(annotationPanelStateAtom), prefix));
        set(annotationBusyAtom, removeEntriesWithPrefix(get(annotationBusyAtom), prefix));
        set(annotationAttachmentTitlesAtom, removeEntriesWithPrefix(get(annotationAttachmentTitlesAtom), prefix));
        set(messageSourcesVisibilityAtom, removeEntry(get(messageSourcesVisibilityAtom), messageId));
        set(thinkingVisibilityAtom, removeEntry(get(thinkingVisibilityAtom), messageId));
    }
);