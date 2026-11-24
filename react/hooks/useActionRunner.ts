import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { isStreamingAtom } from '@beaver/agent-core/run-state/atoms';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { Action } from '@beaver/agent-core/types/actions';
import { stageActionPillAtom } from '../atoms/actions';
import type { ActionBinding } from '../utils/actionVisibility';

/**
 * Shared handler for running an action from a homepage surface (the context
 * bar menu and the category lists).
 *
 * Selecting an action stages a /command pill in the chat input and attaches
 * what the binding resolves to; the user adds any extra context and submits
 * themselves. The action's prompt is resolved at send time. `isBusy` is true
 * while a run is streaming or pending.
 */
export function useActionRunner() {
    const isStreaming = useAtomValue(isStreamingAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const stageActionPill = useSetAtom(stageActionPillAtom);

    const isBusy = isPending || isStreaming;

    // `sourceWindow` identifies the surface the user clicked in (main-window
    // sidebar vs separate Beaver window) so the pill lands in that editor.
    const runAction = useCallback((action: Action, binding: ActionBinding, sourceWindow?: Window | null) => {
        if (isBusy || action.text.length === 0) return;
        stageActionPill({
            actionId: action.id,
            targetType: binding.targetType,
            contextOverride: binding.items ? { items: binding.items, collections: [] } : undefined,
            targetWindow: sourceWindow ?? undefined,
        });
    }, [isBusy, stageActionPill]);

    return { runAction, isBusy };
}
