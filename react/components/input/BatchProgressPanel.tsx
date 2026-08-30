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
 * has already dropped both.
 *
 * Holds a batch this panel drew open briefly after it ends so the completion
 * tick is visible; a batch already finished on mount (reload mid-run) is not
 * held. An expanded panel stays expanded through completion, and a finished
 * leftover stays up after the run itself ends until the user collapses it. A
 * batch still open when the run stops is not a leftover — it disappears with
 * the stamp, expanded or not. A collapsed panel still disappears as soon as
 * the stamp does — the receipt has it then.
 */
const BatchProgressPanel: React.FC = () => {
    const stamp = useAtomValue(batchProgressAtom);

    const { tracked, queued } = useMemo(() => selectBatchPanelGroups(stamp), [stamp]);
    const trackedIsOpen = !!tracked && !hasBatchEnded(tracked);

    const [held, setHeld] = useState<BatchProgressEntry | null>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    // True from the first open stamp we drew until that batch is parked in `held`.
    // The ending render still sees this, so the bar stays mounted (and expanded).
    const drewLiveRef = useRef(false);
    const lastShownRef = useRef<BatchProgressEntry | null>(null);

    if (trackedIsOpen) drewLiveRef.current = true;

    const shown = pickShown({
        trackedIsOpen,
        tracked,
        held,
        isExpanded,
        drewLive: drewLiveRef.current,
        lastShown: lastShownRef.current,
    });
    if (shown) lastShownRef.current = shown;

    useLayoutEffect(() => {
        if (trackedIsOpen) {
            setHeld(null);
            return;
        }
        if (tracked && drewLiveRef.current) {
            drewLiveRef.current = false;
            setHeld(tracked);
            return;
        }
        if (!tracked) {
            drewLiveRef.current = false;
            // Stamp gone with no ended record: the run was stopped mid-batch.
            // Do not keep an active leftover — there is no completion to look at.
            if (isExpanded) {
                setHeld((current) => endedLeftover(current ?? lastShownRef.current));
            } else {
                setHeld(null);
            }
        }
    }, [tracked, trackedIsOpen, isExpanded]);

    // Keyed on `held`, not the stamp: later stamps of the same run would
    // restart the timer and never release the bar. `isExpanded` cancels the
    // dwell while the user is looking, and starts it if they then collapse
    // while the run is still carrying the batch.
    useEffect(() => {
        if (!held || isExpanded) return;
        const timer = setTimeout(() => setHeld(null), COMPLETION_DWELL_MS);
        return () => clearTimeout(timer);
    }, [held, isExpanded]);

    if (!shown) return null;

    return (
        <BatchProgressBar
            batch={shown}
            queuedBatches={queued}
            expanded={isExpanded}
            onExpandedChange={setIsExpanded}
        />
    );
};

/** A leftover is only a batch that actually finished. Stopped mid-flight is not. */
function endedLeftover(entry: BatchProgressEntry | null): BatchProgressEntry | null {
    return entry && hasBatchEnded(entry) ? entry : null;
}

function pickShown(args: {
    trackedIsOpen: boolean;
    tracked: BatchProgressEntry | null;
    held: BatchProgressEntry | null;
    isExpanded: boolean;
    drewLive: boolean;
    lastShown: BatchProgressEntry | null;
}): BatchProgressEntry | null {
    const { trackedIsOpen, tracked, held, isExpanded, drewLive, lastShown } = args;
    if (trackedIsOpen) return tracked;
    if (!tracked) {
        // Run over. Keep a leftover only if it finished and the user is looking.
        return isExpanded ? (endedLeftover(held) ?? endedLeftover(lastShown)) : null;
    }
    if (held) return held;
    // Ending frame: `held` is not set yet. Keep drawing so the bar does not
    // unmount (and lose expansion) before the layout effect parks it.
    if (drewLive) return tracked;
    return null;
}

export default BatchProgressPanel;
