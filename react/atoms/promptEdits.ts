import { atom } from 'jotai';
import type { MessageSearchFilters } from '@beaver/agent-core/agents/types';
import type { MessageAttachment } from '@beaver/agent-core/types/attachments/apiTypes';
import type { SlashCommandDescriptor } from '@beaver/agent-ui/composer/slashCommands';

/**
 * Unsubmitted edits to an already-sent user message.
 *
 * The edit overlay closes on incidental click, Escape, or scroll, so it stashes
 * a half-written revision and restores it on reopen. See
 * {@link promptEditDraftsAtom} for what discards one.
 */
export interface PromptEditDraft {
    /** Message text, including the `/command` tokens for its pills. */
    content: string;
    /** Pills in document order, so the editor rebuilds them as pill nodes. */
    pills: SlashCommandDescriptor[];
    attachments: MessageAttachment[];
    filters: MessageSearchFilters | null;
}

/**
 * Stashed edits keyed by the run id of the user message they belong to.
 *
 * Session-only, and not cleared on a thread switch: returning to a chat still
 * shows what was stashed there. A stash is dropped when its message is
 * cancelled, successfully regenerated, or truncated out of the thread (see
 * `startRegenerateRun`).
 */
export const promptEditDraftsAtom = atom<Record<string, PromptEditDraft>>({});

export const setPromptEditDraftAtom = atom(
    null,
    (get, set, params: { runId: string; draft: PromptEditDraft }) => {
        set(promptEditDraftsAtom, {
            ...get(promptEditDraftsAtom),
            [params.runId]: params.draft,
        });
    },
);

export const clearPromptEditDraftAtom = atom(
    null,
    (get, set, runId: string) => {
        const drafts = get(promptEditDraftsAtom);
        if (!(runId in drafts)) return;
        const next = { ...drafts };
        delete next[runId];
        set(promptEditDraftsAtom, next);
    },
);
