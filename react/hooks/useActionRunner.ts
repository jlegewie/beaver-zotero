import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isStreamingAtom } from '../agents/atoms';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { Action } from '../types/actions';
import { hasUserInputVariables } from '../utils/userInputVariables';
import { markActionUsedAtom, sendResolvedActionAtom, stageActionInInputAtom } from '../atoms/actions';

/**
 * Shared handler for running an action from a launcher surface (the contextual
 * Actions panel and the category skill panels).
 *
 * Actions whose prompt contains `[[ ]]` user-input placeholders are staged in
 * the input for the user to fill in; all others resolve their variables and
 * submit immediately. `isBusy` is true while a run is streaming or pending.
 */
export function useActionRunner() {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const sendResolvedAction = useSetAtom(sendResolvedActionAtom);
    const stageActionInInput = useSetAtom(stageActionInInputAtom);
    const markActionUsed = useSetAtom(markActionUsedAtom);

    const isBusy = isPending || isStreaming;

    const runAction = useCallback(async (action: Action) => {
        if (isBusy || action.text.length === 0) return;
        if (hasUserInputVariables(action.text)) {
            await stageActionInInput({
                actionId: action.id,
                text: action.text,
                targetType: action.targetType,
            });
            return;
        }
        markActionUsed(action.id);
        await sendResolvedAction({ text: action.text, targetType: action.targetType });
    }, [isBusy, sendResolvedAction, stageActionInInput, markActionUsed]);

    return { runAction, isBusy };
}
