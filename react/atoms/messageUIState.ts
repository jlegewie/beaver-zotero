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
    resultsVisible: false,
    isApplying: false
};

type NotePanelState = {
    contentVisible: boolean;
    isSaving: boolean;
};

type NotePanelStateMap = Record<string, NotePanelState>;

export const defaultNotePanelState: NotePanelState = {
    contentVisible: true,
    isSaving: false
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
// Tool call expansion state
// ---------------------------------------------------------------------------

/**
 * Tracks expansion state of tool call views by key (runId:toolCallId)
 */
export const toolExpandedAtom = atom<BooleanMap>({});

/**
 * Toggle expansion of a tool call view
 */
export const toggleToolExpandedAtom = atom(
    null,
    (get, set, key: string) => {
        const current = get(toolExpandedAtom);
        const next = !(current[key] ?? false);
        set(toolExpandedAtom, { ...current, [key]: next });
    }
);

/**
 * Set expansion state of a tool call view
 */
export const setToolExpandedAtom = atom(
    null,
    (get, set, { key, expanded }: { key: string; expanded: boolean }) => {
        const current = get(toolExpandedAtom);
        set(toolExpandedAtom, { ...current, [key]: expanded });
    }
);

// ---------------------------------------------------------------------------
// Sources + thinking sections on assistant messages
// ---------------------------------------------------------------------------

/**
 * Tracks visibility of sources sections by messageId
 */
export const messageSourcesVisibilityAtom = atom<BooleanMap>({});

/**
 * Tracks visibility of thinking sections by messageId
 */
export const thinkingVisibilityAtom = atom<BooleanMap>({});

/**
 * Toggle visibility of an assistant message's sources section
 */
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

/**
 * Toggle visibility of an assistant message's thinking section
 */
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
// Run error visibility
// ---------------------------------------------------------------------------

/**
 * Tracks visibility of run error details by runId
 */
export const runErrorVisibilityAtom = atom<BooleanMap>({});

/**
 * Toggle visibility of a run's error details
 */
export const toggleRunErrorVisibilityAtom = atom(
    null,
    (get, set, runId: string) => {
        const current = get(runErrorVisibilityAtom);
        const next = !(current[runId] ?? false);
        set(runErrorVisibilityAtom, { ...current, [runId]: next });
    }
);

export const setRunErrorVisibilityAtom = atom(
    null,
    (get, set, { runId, visible }: { runId: string; visible: boolean }) => {
        const current = get(runErrorVisibilityAtom);
        set(runErrorVisibilityAtom, { ...current, [runId]: visible });
    }
);

// ---------------------------------------------------------------------------
// Annotation groups (button + busy states)
// ---------------------------------------------------------------------------

/**
 * Tracks visibility and applying state of annotation panels by groupId
 */
export const annotationPanelStateAtom = atom<AnnotationPanelStateMap>({});

/**
 * Tracks busy state of individual annotations by groupId:annotationId
 */
export const annotationBusyAtom = atom<AnnotationBusyStateMap>({});

/**
 * Caches attachment titles for annotation groups by groupId
 */
export const annotationAttachmentTitlesAtom = atom<AnnotationAttachmentTitleMap>({});

// ---------------------------------------------------------------------------
// Edit metadata (item titles)
// ---------------------------------------------------------------------------

type EditMetadataItemTitleMap = Record<string, string | null>;

/**
 * Caches item titles for edit_metadata actions by toolcallId
 */
export const editMetadataItemTitlesAtom = atom<EditMetadataItemTitleMap>({});

export const setEditMetadataItemTitleAtom = atom(
    null,
    (get, set, { key, title }: { key: string; title: string | null }) => {
        const current = get(editMetadataItemTitlesAtom);
        set(editMetadataItemTitlesAtom, { ...current, [key]: title });
    }
);

// ---------------------------------------------------------------------------
// Note panels (button + visibility)
// ---------------------------------------------------------------------------

/**
 * Tracks visibility and saving state of note panels by noteId
 */
export const notePanelStateAtom = atom<NotePanelStateMap>({});

/**
 * Update annotation panel state (visibility, isApplying)
 */
export const setAnnotationPanelStateAtom = atom(
    null,
    (get, set, { key, updates }: { key: string; updates: Partial<AnnotationPanelState> }) => {
        const current = get(annotationPanelStateAtom);
        const existing = current[key] ?? defaultAnnotationPanelState;
        set(annotationPanelStateAtom, { ...current, [key]: { ...existing, ...updates } });
    }
);

/**
 * Toggle visibility of an annotation panel's results
 */
export const toggleAnnotationPanelVisibilityAtom = atom(
    null,
    (get, set, key: string) => {
        const current = get(annotationPanelStateAtom);
        const existing = current[key] ?? defaultAnnotationPanelState;
        set(annotationPanelStateAtom, { ...current, [key]: { ...existing, resultsVisible: !existing.resultsVisible } });
    }
);

/**
 * Set busy state for an individual annotation (shows spinner)
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

/**
 * Update note panel state (visibility, isSaving)
 */
export const setNotePanelStateAtom = atom(
    null,
    (get, set, { key, updates }: { key: string; updates: Partial<NotePanelState> }) => {
        const current = get(notePanelStateAtom);
        const existing = current[key] ?? defaultNotePanelState;
        set(notePanelStateAtom, { ...current, [key]: { ...existing, ...updates } });
    }
);

/**
 * Toggle visibility of a note panel's content
 */
export const toggleNotePanelVisibilityAtom = atom(
    null,
    (get, set, key: string) => {
        const current = get(notePanelStateAtom);
        const existing = current[key] ?? defaultNotePanelState;
        set(notePanelStateAtom, { ...current, [key]: { ...existing, contentVisible: !existing.contentVisible } });
    }
);

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Reset all UI state (used when starting a new thread)
 */
export const resetMessageUIStateAtom = atom(
    null,
    (_get, set) => {
        set(toolExpandedAtom, {});
        set(messageSourcesVisibilityAtom, {});
        set(thinkingVisibilityAtom, {});
        set(runErrorVisibilityAtom, {});
        set(annotationPanelStateAtom, {});
        set(annotationBusyAtom, {});
        set(annotationAttachmentTitlesAtom, {});
        set(editMetadataItemTitlesAtom, {});
        set(notePanelStateAtom, {});
    }
);
