/**
 * Showing a feature tip: whether now is a good moment, and where it goes.
 */
import { atom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../src/utils/prefs';
import { FEATURE_TIPS, type FeatureTipId } from '../constants/featureTips';
import { popupMessagesAtom } from './ui';
import { addPopupMessageAtom, removePopupMessageAtom } from '../utils/popupMessageUtils';
import {
    addFloatingPopupMessageAtom,
    floatingPopupMessagesAtom,
    removeFloatingPopupMessageAtom,
} from './floatingPopup';
import {
    hasSeenFeatureTip,
    isFeatureTipDeferred,
    isWithinFeatureTipGap,
    markFeatureTipShown,
    readFeatureTipState,
    writeFeatureTipState,
} from '../utils/featureTipPrefs';

export const featureTipMessageId = (tipId: FeatureTipId): string => `feature-tip:${tipId}`;

export interface ShowFeatureTipOptions {
    /** Skip the seen check and the pacing; for previews. */
    force?: boolean;
    /** Override where the tip goes; for previews. */
    inPanel?: boolean;
}

/**
 * Shows a tip if the moment is right, and records that it was shown.
 *
 * A tip is shown once, never while another popup of either kind is up, and
 * never within the gap of the previous tip, the release notes, or the welcome
 * card — the user is being told one thing at a time. Returns whether it was
 * shown; the trigger uses that to stop asking.
 */
export const showFeatureTipAtom = atom(
    null,
    (get, set, tipId: FeatureTipId, options: ShowFeatureTipOptions = {}): boolean => {
        const definition = FEATURE_TIPS[tipId];
        if (!definition) return false;

        if (!options.force) {
            const state = readFeatureTipState();
            if (hasSeenFeatureTip(state, tipId)) return false;
            if (isFeatureTipDeferred(state, tipId, Date.now())) return false;
            if (isWithinFeatureTipGap(state, Date.now(), [
                getPref('versionUpdatePopupShownAt'),
                getPref('onboardingWelcomeShownAt'),
            ])) {
                logger(`showFeatureTipAtom: Holding "${tipId}" (another tip was shown recently)`);
                return false;
            }
            if (get(floatingPopupMessagesAtom).length > 0 || get(popupMessagesAtom).length > 0) {
                logger(`showFeatureTipAtom: Holding "${tipId}" (another popup is showing)`);
                return false;
            }
            writeFeatureTipState(markFeatureTipShown(state, tipId, Date.now()));
        }

        const inPanel = options.inPanel ?? definition.inPanel;
        logger(`showFeatureTipAtom: Showing "${tipId}" ${inPanel ? 'in the panel' : 'floating'}`);
        set(inPanel ? addPopupMessageAtom : addFloatingPopupMessageAtom, {
            id: featureTipMessageId(tipId),
            type: 'feature_tip',
            tipId,
            expire: false,
            cancelable: false,
        });
        return true;
    },
);

/** Retires a tip wherever it was shown. */
export const dismissFeatureTipAtom = atom(null, (_get, set, tipId: FeatureTipId) => {
    set(removePopupMessageAtom, featureTipMessageId(tipId));
    set(removeFloatingPopupMessageAtom, featureTipMessageId(tipId));
});
