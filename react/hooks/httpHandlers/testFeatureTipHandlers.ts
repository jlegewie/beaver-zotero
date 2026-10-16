/**
 * Dev-only HTTP handler for the one-time feature tips.
 *
 * `/beaver/test/feature-tip` draws a tip regardless of whether it was seen or
 * how recently another was shown: `{ tipId, show: true, inPanel? }` shows it
 * (`inPanel` overrides where it goes), `{ tipId, show: false }` removes it.
 * The tip's own state in the preferences is left alone.
 *
 * Wired to its path in `useHttpEndpoints.ts`.
 */

import { store } from '../../store';
import { dismissFeatureTipAtom, showFeatureTipAtom } from '../../atoms/featureTips';
import { FEATURE_TIPS, type FeatureTipId } from '../../constants/featureTips';

export async function handleTestFeatureTipHttpRequest(request: any): Promise<any> {
    const tipId = request?.tipId as FeatureTipId;
    if (!FEATURE_TIPS[tipId]) {
        throw new Error(`Unknown feature tip: ${String(request?.tipId)}. Known: ${Object.keys(FEATURE_TIPS).join(', ')}`);
    }
    if (request?.show === false) {
        store.set(dismissFeatureTipAtom, tipId);
        return { tipId, shown: false };
    }
    const shown = store.set(showFeatureTipAtom, tipId, {
        force: true,
        inPanel: typeof request?.inPanel === 'boolean' ? request.inPanel : undefined,
    });
    return { tipId, shown };
}
