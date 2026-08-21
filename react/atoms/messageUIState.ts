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
// Input warning dismissal state
// ---------------------------------------------------------------------------

/**
 * Tracks dismissed high token usage warnings by thread ID.
 * Once dismissed in a thread, the warning stays hidden for that thread's session.
 */
export const dismissedHighTokenWarningByThreadAtom = atom<Record<string, boolean>>({});

/**
 * Mark the high token usage warning as dismissed for a thread.
 */
export const dismissHighTokenWarningForThreadAtom = atom(
    null,
    (get, set, threadId: string) => {
        const current = get(dismissedHighTokenWarningByThreadAtom);
        set(dismissedHighTokenWarningByThreadAtom, { ...current, [threadId]: true });
    }
);

/**
 * Transient backend flags from WSRunCompleteEvent, keyed by run ID.
 * These are NOT persisted -- they only live for the current session.
 */
export const backendHighTokenUsageRunsAtom = atom<Record<string, boolean>>({});

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
// Agent action item titles
// ---------------------------------------------------------------------------

type AgentActionItemTitleMap = Record<string, string | null>;

/**
 * Caches item titles for agent actions (when applicable) by toolcallId
 */
export const agentActionItemTitlesAtom = atom<AgentActionItemTitleMap>({});

export const setAgentActionItemTitleAtom = atom(
    null,
    (get, set, { key, title }: { key: string; title: string | null }) => {
        const current = get(agentActionItemTitlesAtom);
        set(agentActionItemTitlesAtom, { ...current, [key]: title });
    }
);

// ---------------------------------------------------------------------------
// Review card session snapshot
// ---------------------------------------------------------------------------

/**
 * Actions resolved from the currently rendered review card, keyed
 * `runId:actionId`. This keeps resolved rows stable until the last pending
 * row settles. It is deliberately not persisted across thread loads.
 */
export const retainedReviewActionsAtom = atom<BooleanMap>({});

export const retainReviewActionsAtom = atom(
    null,
    (get, set, { runId, actionIds }: { runId: string; actionIds: string[] }) => {
        const current = get(retainedReviewActionsAtom);
        const next = { ...current };
        for (const actionId of actionIds) next[`${runId}:${actionId}`] = true;
        set(retainedReviewActionsAtom, next);
    },
);

/** Remove a completed review snapshot so it cannot replay after a React remount. */
export const clearRetainedReviewActionsForRunAtom = atom(
    null,
    (get, set, runId: string) => {
        const current = get(retainedReviewActionsAtom);
        set(retainedReviewActionsAtom, removeEntriesWithPrefix(current, `${runId}:`));
    },
);

// ---------------------------------------------------------------------------
// Applied changes session snapshot
// ---------------------------------------------------------------------------

/**
 * Action ids written to Zotero *by a live run* in this app session.
 *
 * The completed-changes card summarizes what a run changed on its own, so the
 * set holds only the writes the run itself made — the ones the user approved
 * while it was streaming and the ones an always-apply permission let it make
 * without asking. Changes the user applies from the review card after the run
 * ended are deliberately excluded: that card already shows them resolved, and
 * repeating them below it would show the same tool call twice.
 *
 * Scoped to this set rather than to the `applied` status because a create_note
 * action stays `applied` forever, so a status-driven card would grow back onto
 * the bottom of every thread the user ever reopens, while the in-stream cards
 * already carry that history.
 *
 * Recorded where a run's write completes: the WS handlers for backend-executed
 * actions, and the client-side auto-apply paths (`autoApplyAnnotationAgentActions`,
 * `autoCreateNoteAgentActions`). Not in `ackAgentActionsAtom` — that funnel also
 * carries the post-run applies this set must not contain.
 *
 * Session-only on purpose, and deliberately not cleared by
 * `resetMessageUIStateAtom`: switching threads and coming back within one
 * session should not drop what the user has not dismissed.
 */
export const sessionAppliedActionIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

/** Record a live run's writes, making them completed-card material. */
export const recordAppliedActionsAtom = atom(
    null,
    (get, set, actionIds: string[]) => {
        if (actionIds.length === 0) return;
        const current = get(sessionAppliedActionIdsAtom);
        const next = new Set(current);
        for (const actionId of actionIds) next.add(actionId);
        set(sessionAppliedActionIdsAtom, next);
    },
);

/**
 * Drop actions from the session snapshot, which is how the completed-changes
 * card is dismissed. Nothing about the action records changes: the change stays
 * applied in Zotero and in history — only this session's card forgets it.
 */
export const dismissAppliedActionsAtom = atom(
    null,
    (get, set, actionIds: string[]) => {
        const current = get(sessionAppliedActionIdsAtom);
        const next = new Set(current);
        let removed = false;
        for (const actionId of actionIds) removed = next.delete(actionId) || removed;
        if (removed) set(sessionAppliedActionIdsAtom, next);
    },
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
 * Reset thread-local UI state when starting a new thread.
 *
 * Session-scoped warning state is intentionally preserved so revisiting an
 * existing thread in the same app session keeps its warning visibility and
 * dismissal behavior intact.
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
        set(agentActionItemTitlesAtom, {});
        set(retainedReviewActionsAtom, {});
        set(notePanelStateAtom, {});
    }
);
