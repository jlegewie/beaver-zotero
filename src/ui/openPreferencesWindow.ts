import { BeaverUIFactory } from './ui';
import { PreferencePageTab } from '../../react/atoms/ui';

/**
 * Open Beaver preferences in a separate window.
 * If a window already exists, it will be focused and switched to the given tab.
 */
export function openPreferencesWindow(tab?: PreferencePageTab): void {
    BeaverUIFactory.openPreferencesWindow(tab);
}
