import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { actionsAtom } from '../atoms/actions';
import type { ActionPopupSource } from '@beaver/agent-ui/chat/actionPopup';

/**
 * Resolves a /command pill's action id to the content its hover card shows.
 *
 * The composer is client-agnostic and never reads Zotero's action store, so
 * this hook does the subscribing and hands the lookup down as a prop (see
 * `LexicalEditorInputProps.resolveAction`). Returns null for an action the user
 * has since deleted, which leaves the card on the pill's own snapshot.
 */
export function useActionPopupResolver(): (actionId: string) => ActionPopupSource | null {
    const actions = useAtomValue(actionsAtom);
    return useMemo(
        () => (actionId: string) => {
            const action = actions.find((a) => a.id === actionId);
            if (!action) return null;
            return {
                title: action.title,
                description: action.description,
                prompt: action.text,
                category: action.category,
            };
        },
        [actions],
    );
}
