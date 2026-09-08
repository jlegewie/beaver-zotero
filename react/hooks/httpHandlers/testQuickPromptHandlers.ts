/**
 * Dev-only HTTP handler for the quick prompt (`react/components/quickPrompt`).
 *
 * `/beaver/test/quick-prompt` drives the closed-sidebar composer without the
 * keyboard: `{ toggle: true }` runs the shortcut's own action (and reports
 * what it did), `{ open: true }` / `{ open: false }` set the popup directly.
 * Every call returns the popup's state. Wired to its path in
 * `useHttpEndpoints.ts`.
 */

import { store } from '../../store';
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
    } else if (request?.open === true) {
        await store.set(openQuickPromptAtom);
    } else if (request?.open === false) {
        store.set(closeQuickPromptAtom);
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
