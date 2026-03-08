/**
 * Action visibility — determines whether an action should be shown
 * (enabled) given the current Zotero context.
 */

import { Action } from '../types/actions';
import { ZoteroContext } from '../atoms/zoteroContext';

/**
 * Returns `true` when the action makes sense in the given context.
 *
 * For V2.0, `attachment` uses a conservative heuristic: it's visible when
 * items are selected (they might have PDF children) or when a reader is open.
 * V2.1 can refine this with actual attachment checking.
 */
export function isActionVisible(action: Action, context: ZoteroContext): boolean {
    switch (action.targetType) {
        case 'items': {
            const minItems = action.minItems ?? 1;
            if (context.type === 'reader') return minItems <= 1;
            return context.selectedItemCount >= minItems;
        }
        case 'attachment':
            return context.type === 'reader' || context.selectedItemCount > 0;
        case 'note':
            return context.type === 'note';
        case 'collection':
            return context.libraryView.treeRowType === 'collection';
        case 'global':
            return true;
    }
}
