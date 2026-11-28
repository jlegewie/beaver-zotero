import { BeaverUIFactory } from './ui';
import { PreferencePageTab } from '../../react/atoms/ui';
import type { ActionsListFilter } from '@beaver/agent-core/types/actions';

/**
 * Open Beaver preferences in a separate window.
 * If a window already exists, it will be focused and switched to the given tab.
 * `actionsFilter` requests that the Actions tab pre-filter its list by category
 * and/or "Applies to" (an action added there inherits both). `actionId`
 * requests that the Actions tab reveal that action and open it in edit mode.
 */
export function openPreferencesWindow(tab?: PreferencePageTab, actionsFilter?: ActionsListFilter, actionId?: string, window?: Window): void {
    BeaverUIFactory.openPreferencesWindow(tab, actionsFilter, actionId, window);
}
