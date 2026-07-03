import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isStreamingAtom } from '../agents/atoms';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { Action } from '../types/actions';
import { stageActionPillAtom, actionContextAtom } from '../atoms/actions';
import { getActiveTarget, resolveActionBinding } from '../utils/actionVisibility';

/**
 * Shared handler for running an action from a launcher surface (the contextual
 * Actions panel and the category skill panels).
 *
 * Selecting an action stages a /command pill in the chat input; the user adds
 * any extra context and submits themselves. The action's prompt is resolved at
 * send time. The pill carries the single resolved target type — the active
 * context target when the action accepts it (see `resolveActionBinding`).
 * `isBusy` is true while a run is streaming or pending.
 */
export function useActionRunner() {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const ctx = useAtomValue(actionContextAtom);
    const stageActionPill = useSetAtom(stageActionPillAtom);

    const isBusy = isPending || isStreaming;

    // `sourceWindow` identifies the surface the user clicked in (main-window
    // sidebar vs separate Beaver window) so the pill lands in that editor.
    const runAction = useCallback((action: Action, sourceWindow?: Window | null) => {
        if (isBusy || action.text.length === 0) return;
        stageActionPill({
            actionId: action.id,
            targetType: resolveActionBinding(action, getActiveTarget(ctx)),
            targetWindow: sourceWindow ?? undefined,
        });
    }, [isBusy, ctx, stageActionPill]);

    return { runAction, isBusy };
}
