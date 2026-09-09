/**
 * Dev-only HTTP handler for the closed-sidebar run status popup
 * (`react/components/runStatusPopup`).
 *
 * `/beaver/test/run-status-popup` draws any of the popup's states on demand,
 * without a run in that state: `{ preview: { kind: 'approval', ... } }` sets
 * the preview card, `{ clear: true }` removes it, and `{ forceVisible: true }`
 * keeps the popup on screen while the sidebar is open. The preview's own
 * controls only clear the preview. `{ completion: { runId } }` shows the real
 * completed card for a run of the open thread, so its rows can be exercised
 * without waiting for a run to finish with the sidebar closed. Every field but `kind` is optional and
 * falls back to sample copy — see `RunStatusPopupPreview`. `{ tip: true }`
 * shows the one-time onboarding tip about the popup (`tipInPanel` overrides
 * where it goes); `{ tip: false }` removes it.
 *
 * Wired to its path in `useHttpEndpoints.ts`.
 */

import { store } from '../../store';
import { dismissFeatureTipAtom, showFeatureTipAtom } from '../../atoms/featureTips';
import {
    runStatusPopupCompletionAtom,
    runStatusPopupForceVisibleAtom,
    runStatusPopupPreviewAtom,
    type RunStatusPopupPreview,
} from '../../atoms/runStatusPopup';

const PREVIEW_KINDS = new Set<RunStatusPopupPreview['kind']>([
    'running', 'approval', 'credit', 'batch', 'question', 'completed',
]);

export async function handleTestRunStatusPopupHttpRequest(request: any): Promise<any> {
    if (request?.clear) {
        store.set(runStatusPopupPreviewAtom, null);
        store.set(runStatusPopupForceVisibleAtom, false);
    }
    if (typeof request?.forceVisible === 'boolean') {
        store.set(runStatusPopupForceVisibleAtom, request.forceVisible);
    }
    if (request?.tip === true) {
        store.set(showFeatureTipAtom, 'run-status-popup', {
            force: true,
            inPanel: typeof request.tipInPanel === 'boolean' ? request.tipInPanel : undefined,
        });
    } else if (request?.tip === false) {
        store.set(dismissFeatureTipAtom, 'run-status-popup');
    }
    if (request?.clearCompletion) {
        store.set(runStatusPopupCompletionAtom, null);
    }
    // Draw the completed card for a run of the open thread, as if it had just
    // finished while the sidebar was closed; its rows act on the real run.
    if (typeof request?.completion?.runId === 'string') {
        store.set(runStatusPopupCompletionAtom, { runId: request.completion.runId, completedAt: Date.now() });
    }
    if (request?.preview) {
        const preview = request.preview as RunStatusPopupPreview;
        if (!PREVIEW_KINDS.has(preview.kind)) {
            throw new Error(`Unknown preview kind: ${String(preview.kind)}`);
        }
        store.set(runStatusPopupPreviewAtom, preview);
    }
    return {
        preview: store.get(runStatusPopupPreviewAtom),
        forceVisible: store.get(runStatusPopupForceVisibleAtom),
        completion: store.get(runStatusPopupCompletionAtom),
    };
}
