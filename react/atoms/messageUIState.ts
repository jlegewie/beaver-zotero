import { atom, type Atom, type PrimitiveAtom, type Setter } from 'jotai';

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

export const defaultAnnotationPanelState: AnnotationPanelState = {
    resultsVisible: false,
    isApplying: false
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

// ---------------------------------------------------------------------------
// Keyed title caches
// ---------------------------------------------------------------------------

/** The value read for an absent key, shared so it never re-renders a reader. */
const NO_TITLE_ATOM: Atom<string | null> = atom(() => null);

/**
 * A cache of display titles in which every key is its own atom.
 *
 * A thread can hold hundreds of cards that each cache one title. Kept in a
 * single map atom, every card would subscribe to the whole map, and each title
 * written would re-render every card — quadratic in the cards mounted. With a
 * per-key atom a write re-renders only the surfaces showing that key.
 */
function createTitleCache() {
    const atoms = new Map<string, PrimitiveAtom<string | null>>();

    const entry = (key: string): PrimitiveAtom<string | null> => {
        let cached = atoms.get(key);
        if (!cached) {
            cached = atom<string | null>(null);
            atoms.set(key, cached);
        }
        return cached;
    };

    return {
        /** The cached title for `key`; null until one is written, or for a null key. */
        titleAtom: (key: string | null): Atom<string | null> => (key === null ? NO_TITLE_ATOM : entry(key)),
        setTitleAtom: atom(
            null,
            (_get, set, { key, title }: { key: string; title: string | null }) => {
                set(entry(key), title);
            }
        ),
        /**
         * Empty every title and forget the keys. Readers hold the atom they were
         * given, so this is only safe once they unmount — when a new thread
         * replaces the one whose cards read these titles.
         */
        clear: (set: Setter) => {
            for (const cached of atoms.values()) set(cached, null);
            atoms.clear();
        },
    };
}

const annotationAttachmentTitles = createTitleCache();

/** Caches the attachment title of an annotation tool call, keyed by its tool-call id. */
export const annotationAttachmentTitleAtom = annotationAttachmentTitles.titleAtom;

export const setAnnotationAttachmentTitleAtom = annotationAttachmentTitles.setTitleAtom;

// ---------------------------------------------------------------------------
// Agent action item titles
// ---------------------------------------------------------------------------

/**
 * Cache identity for a tool call's item title. Tool-call ids are unique only
 * within a run, and continued answers can render several runs together.
 */
export function getAgentActionItemTitleKey(runId: string, toolcallId: string): string {
    return `${runId}:${toolcallId}`;
}

const agentActionItemTitles = createTitleCache();

/** Caches the item title of an agent-action surface by its scoped cache key. */
export const agentActionItemTitleAtom = agentActionItemTitles.titleAtom;

export const setAgentActionItemTitleAtom = agentActionItemTitles.setTitleAtom;

// ---------------------------------------------------------------------------
// Note panels (button + visibility)
// ---------------------------------------------------------------------------

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
        annotationAttachmentTitles.clear(set);
        agentActionItemTitles.clear(set);
    }
);
