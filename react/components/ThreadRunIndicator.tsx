import React from 'react';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import AwaitingInputDot from './AwaitingInputDot';
import type { ThreadRunStatus } from '../atoms/runActivity';

/**
 * Marks a chat in a thread list by its run: a spinner while a response is
 * going, the awaiting-input dot while it waits for the user. Hidden from
 * screen readers: the row's label carries the same text
 * (`threadRunStatusLabel`).
 */
const ThreadRunIndicator: React.FC<{ status: ThreadRunStatus | null }> = ({ status }) => {
    if (!status) return null;
    if (status.kind === 'awaiting') return <AwaitingInputDot awaiting={status.awaiting} />;
    return (
        <Tooltip content="Responding" singleLine anchorDisplay="inline-flex">
            <span className="thread-run-indicator" aria-hidden="true">
                <Spinner size={9} />
            </span>
        </Tooltip>
    );
};

export default ThreadRunIndicator;
