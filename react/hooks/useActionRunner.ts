import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isStreamingAtom } from '../agents/atoms';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { Action } from '../types/actions';
import { stageActionPillAtom } from '../atoms/actions';

/**
 * Shared handler for running an action from a launcher surface (the contextual
 * Actions panel and the category skill panels).
 *
 * Selecting an action stages a /command pill in the chat input; the user adds
 * any extra context and submits themselves. The action's prompt is resolved at
 * send time. `isBusy` is true while a run is streaming or pending.
 */
export function useActionRunner() {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const stageActionPill = useSetAtom(stageActionPillAtom);

    const isBusy = isPending || isStreaming;

    // `sourceWindow` identifies the surface the user clicked in (main-window
    // sidebar vs separate Beaver window) so the pill lands in that editor.
    const runAction = useCallback((action: Action, sourceWindow?: Window | null) => {
        if (isBusy || action.text.length === 0) return;
        stageActionPill({
            actionId: action.id,
            targetType: action.targetType,
            targetWindow: sourceWindow ?? undefined,
        });
    }, [isBusy, stageActionPill]);

    return { runAction, isBusy };
}
