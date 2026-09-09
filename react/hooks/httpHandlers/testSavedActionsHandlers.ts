/**
 * Dev-only HTTP handler listing the saved actions with their slash commands,
 * so a headless driver can send a /command pill through `/beaver/test/chat-send`.
 */

import { store } from '../../store';
import { actionsAtom } from '../../atoms/actions';
import { getActionCommand } from '@beaver/agent-ui/composer/slashCommands';
import type { Action } from '@beaver/agent-core/types/actions';

export async function handleTestListSavedActionsHttpRequest(_request: any): Promise<any> {
    const actions: Action[] = store.get(actionsAtom);
    return {
        ok: true,
        actions: actions.map((action) => ({
            id: action.id,
            title: action.title,
            command: getActionCommand(action),
        })),
    };
}
