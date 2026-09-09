import { atom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';

/**
 * The run whose completion the closed-sidebar status popup is reporting.
 *
 * A run that finishes while the sidebar is closed has nowhere to announce
 * itself, so the popup keeps a completed card up for it. The record is stamped
 * when the run turns terminal with the sidebar closed, and cleared when the
 * user dismisses the card, opens Beaver, or starts another run — the sidebar
 * then carries the answer, and a card that outlived it would report a result
 * the user has already seen.
 */
export interface RunStatusPopupCompletion {
    runId: string;
    /** When the run turned terminal, in epoch ms. */
    completedAt: number;
}

export const runStatusPopupCompletionAtom = atom<RunStatusPopupCompletion | null>(null);

/**
 * A card the dev endpoint asked the popup to draw instead of the live state.
 *
 * Every state the popup can reach depends on a run being in exactly that state,
 * which is slow to reproduce and bills credits. The preview lets each be drawn
 * on demand; its controls only clear the preview. Serializable on purpose — it
 * arrives over HTTP.
 */
export type RunStatusPopupPreview =
    | { kind: 'running'; threadName?: string; statusLine?: string; stackDepth?: number }
    | {
        kind: 'approval';
        threadName?: string;
        label?: string;
        count?: number;
        /** Draw the run-permission menu; off for a confirm-only card. */
        showPermissionMenu?: boolean;
        /** Tool the single action's icon is drawn for, e.g. `create_note`. */
        actionType?: string;
        approveLabel?: string;
        rejectLabel?: string;
        stackDepth?: number;
    }
    | {
        kind: 'credit';
        threadName?: string;
        title?: string;
        message?: string;
        approveLabel?: string;
        declineLabel?: string;
        stackDepth?: number;
    }
    | {
        kind: 'batch';
        threadName?: string;
        /** The backend-composed copy the shared approval card renders verbatim. */
        title?: string;
        scopePrimary?: string;
        scopeSecondary?: string;
        message?: string;
        destructiveWarning?: string;
        costWarning?: string;
        creditChip?: string;
        creditTooltip?: string;
        userInstructionsPrefill?: string;
        /** A batch that changes nothing, so the card offers no coverage choice. */
        readOnly?: boolean;
        stackDepth?: number;
    }
    | { kind: 'question'; threadName?: string; title?: string; stackDepth?: number }
    | {
        kind: 'completed';
        threadName?: string;
        outcome?: 'completed' | 'error' | 'canceled';
        /** The run error type, for the title an `error` outcome carries. */
        errorType?: string;
        artifacts?: string[];
        /** The changes-card trail, e.g. "2 applied, 1 pending". */
        changes?: string;
        stackDepth?: number;
    };

export const runStatusPopupPreviewAtom = atom<RunStatusPopupPreview | null>(null);

/**
 * Show the popup even while the sidebar is open. Dev-only, for inspecting the
 * card beside the surface it stands in for.
 */
export const runStatusPopupForceVisibleAtom = atom(false);

/**
 * Cards the user has closed. Keyed by what the card was about — a run's
 * working state, one set of approvals, one confirmation — so closing the
 * working card does not also hide the decision the same run asks for a
 * moment later. Cleared when another run takes the thread over.
 */
export const runStatusPopupDismissedAtom = atom<ReadonlySet<string>>(new Set<string>());

export const dismissRunStatusPopupCardAtom = atom(null, (get, set, signature: string) => {
    const next = new Set(get(runStatusPopupDismissedAtom));
    next.add(signature);
    set(runStatusPopupDismissedAtom, next);
});

/**
 * The `enableRunStatusPopup` preference, mirrored so the popup follows a
 * change made in the preferences window without a reload. Read lazily: the
 * preference store is not there when this module loads.
 */
const runStatusPopupEnabledOverrideAtom = atom<boolean | null>(null);

export const runStatusPopupEnabledAtom = atom(
    (get) => get(runStatusPopupEnabledOverrideAtom) ?? getPref('enableRunStatusPopup') !== false,
    (_get, set, enabled: boolean) => {
        setPref('enableRunStatusPopup', enabled);
        set(runStatusPopupEnabledOverrideAtom, enabled);
    },
);
