/**
 * Dev-only HTTP handler for the quick prompt (`react/components/quickPrompt`).
 *
 * `/beaver/test/quick-prompt` drives the closed-sidebar composer without the
 * keyboard: `{ toggle: true }` runs the shortcut's own action (and reports
 * what it did), `{ open: true }` / `{ open: false }` set the popup directly,
 * and `{ state: { mode: 'blocked', reason } }` draws a notice without the
 * account being in that state. Every call returns the popup's state. Wired to
 * its path in `useHttpEndpoints.ts`.
 */

import { store } from '../../store';
import { eventManager } from '../../events/eventManager';
import {
    closeQuickPromptAtom,
    openQuickPromptAtom,
    quickPromptStateAtom,
    toggleQuickPromptAtom,
    type QuickPromptToggleOutcome,
} from '../../atoms/quickPrompt';
import { isSidebarVisibleAtom } from '../../atoms/ui';
import { currentThreadIdAtom } from '../../atoms/threads';
import { runsCountAtom } from '@beaver/agent-core/run-state/atoms';
import { currentMessageContentAtom } from '../../atoms/messageComposition';

export async function handleTestQuickPromptHttpRequest(request: any): Promise<any> {
    let outcome: QuickPromptToggleOutcome | null = null;
    if (request?.toggle === true) {
        outcome = await store.set(toggleQuickPromptAtom);
        if (outcome === 'replace-sidebar') {
            // The shortcut swaps an open sidebar for the popup. Closing the
            // sidebar is the popup component's half of that; do it here too so
            // the endpoint runs the same path the keyboard does.
            eventManager.dispatch('toggleChat', {});
            await store.set(openQuickPromptAtom);
        }
    } else if (request?.open === true) {
        await store.set(openQuickPromptAtom);
    } else if (request?.open === false) {
        store.set(closeQuickPromptAtom);
    } else if (request?.state && typeof request.state.mode === 'string') {
        store.set(quickPromptStateAtom, request.state);
    }
    return {
        outcome,
        state: store.get(quickPromptStateAtom),
        sidebarVisible: store.get(isSidebarVisibleAtom),
        threadId: store.get(currentThreadIdAtom),
        runCount: store.get(runsCountAtom),
        draft: store.get(currentMessageContentAtom),
    };
}
