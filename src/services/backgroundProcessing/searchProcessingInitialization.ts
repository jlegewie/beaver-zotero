import { getPref, setPref } from '../../utils/prefs';

/** Enable maintenance once when search becomes available, preserving subsequent user pauses. */
export function initializeSearchProcessing(hasAccess: boolean): void {
    if (!hasAccess || getPref('backgroundProcessingSearchInitialized') === true) return;
    setPref('backgroundProcessingEnabled', true);
    setPref('backgroundProcessingSearchInitialized', true);
}
