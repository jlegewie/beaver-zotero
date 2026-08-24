import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import BatchProgressBar from '@beaver/agent-ui/chat/BatchProgressBar';
import { hasBatchEnded, selectBatchPanelGroups } from '@beaver/agent-core/run-state/batchProgress';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import { batchProgressAtom } from '../../atoms/agentRunAtoms';

/** How long a finished batch's bar stays up so the completion tick is visible. */
const COMPLETION_DWELL_MS = 2500;

/**
 * Live batch progress above the composer.
 *
 * Draws the batch being worked and what is queued. Finished batches belong
 * under the run (`BatchRunReceipt`), and a batch nothing is working — paused,
 * or left open by a run that was stopped — is drawn nowhere: `batchProgressAtom`
 * has already dropped both. Holds a batch this panel drew open briefly after it
 * ends so the completion tick is visible; a batch already finished on mount
 * (reload mid-run) is not held.
 */
const BatchProgressPanel: React.FC = () => {
    const stamp = useAtomValue(batchProgressAtom);

    const { tracked, queued } = useMemo(() => selectBatchPanelGroups(stamp), [stamp]);
    const trackedIsOpen = !!tracked && !hasBatchEnded(tracked);

    // Held batch, and whether the current tracked batch was drawn while open.
    // Entered in layout so the bar does not blink out on the ending render.
    const [held, setHeld] = useState<BatchProgressEntry | null>(null);
    const wasOpenRef = useRef(false);

    useLayoutEffect(() => {
        // Run ended: the receipt has it now. Do not draw it in both places.
        if (!tracked) {
            wasOpenRef.current = false;
            setHeld(null);
            return;
        }
        if (trackedIsOpen) {
            wasOpenRef.current = true;
            setHeld(null);
            return;
        }
        if (!wasOpenRef.current) return;
        wasOpenRef.current = false;
        setHeld(tracked);
    }, [tracked, trackedIsOpen]);

    // Keyed on `held`, not the stamp: later stamps of the same run would
    // restart the timer and never release the bar.
    useEffect(() => {
        if (!held) return;
        const timer = setTimeout(() => setHeld(null), COMPLETION_DWELL_MS);
        return () => clearTimeout(timer);
    }, [held]);

    const shown = trackedIsOpen ? tracked : held;
    if (!shown) return null;

    return <BatchProgressBar batch={shown} queuedBatches={queued} />;
};

export default BatchProgressPanel;
