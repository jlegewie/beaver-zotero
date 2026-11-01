import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import {
    REATTACH_CHECKING_MESSAGE,
    REATTACH_STILL_RUNNING_MESSAGE,
} from '@beaver/agent-core/transport/connectionFailure';
import { Icon, InformationCircleIcon, Spinner } from '../icons/icons';
import {
    REATTACH_RESOLUTION_WINDOW_MS,
    reattachResolutionAtom,
    reattachResolutionView,
    type ReattachResolutionView,
} from '@beaver/agent-core/run-state/runResolution';
import { admissionUnreachableAtom, threadAdmissionAtom } from '../../runtime/threadAdmission';

/**
 * What a run whose reattach failed shows instead of its connection error, or
 * null to show the error. Re-renders when the "checking" window runs out.
 */
export function useReattachResolutionView(runId: string, enabled: boolean): ReattachResolutionView {
    const resolution = useAtomValue(reattachResolutionAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const admission = useAtomValue(threadAdmissionAtom);
    const unreachable = useAtomValue(admissionUnreachableAtom);
    const [, setExpired] = useState(0);
    const tracked = enabled && resolution?.runId === runId ? resolution : null;
    useEffect(() => {
        if (!tracked) return;
        const remaining = tracked.since + REATTACH_RESOLUTION_WINDOW_MS - Date.now();
        if (remaining <= 0) return;
        const timer = setTimeout(() => setExpired((value) => value + 1), remaining + 20);
        return () => clearTimeout(timer);
    }, [tracked]);
    if (!tracked) return null;
    return reattachResolutionView({
        resolution: tracked,
        runId,
        currentThreadId,
        activityState: admission?.threadId === currentThreadId ? admission.activity.state : null,
        activityRunId: admission?.threadId === currentThreadId ? admission.activity.run_id : null,
        unreachable,
        now: Date.now(),
    });
}

/**
 * The neutral state of a failed reattach while the server reports how the run
 * ended. Not a live region: the presence bar announces the same wait.
 */
export const ReattachResolutionNotice: React.FC<{ view: Exclude<ReattachResolutionView, null> }> = ({ view }) => (
    <div className="px-4">
        <div className="display-flex flex-row gap-2 px-3 py-15 font-color-secondary">
            <div className="display-flex mt-020 flex-none">
                <Spinner size={12} />
            </div>
            <div className="text-base min-w-0">
                {view === 'still_running' ? REATTACH_STILL_RUNNING_MESSAGE : REATTACH_CHECKING_MESSAGE}
            </div>
        </div>
    </div>
);

/** A one-line, UI-only note on a run: how it ended differs from what was shown. */
export const RunNotice: React.FC<{ text: string }> = ({ text }) => (
    <div className="px-4">
        <div className="display-flex flex-row gap-2 px-3 font-color-tertiary">
            <div className="display-flex mt-010 flex-none">
                <Icon icon={InformationCircleIcon} />
            </div>
            <div className="text-base min-w-0">{text}</div>
        </div>
    </div>
);
