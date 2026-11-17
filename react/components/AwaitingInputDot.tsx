import React from 'react';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { awaitingIndicator, awaitingInputLabel, type AwaitingInput } from '../../src/services/threads/awaitingInput';

/**
 * Marks a chat in a thread list whose parked run waits: a dot when it waits
 * on the user (answers, or a finished job to continue with), a spinner when
 * only a job works for it. The tooltip says what it waits on. Hidden from
 * screen readers: the row's label carries the same text.
 */
const AwaitingInputDot: React.FC<{ awaiting: AwaitingInput }> = ({ awaiting }) => (
    <Tooltip content={awaitingInputLabel(awaiting)} singleLine anchorDisplay="inline-flex">
        <span className="thread-awaiting-input" aria-hidden="true">
            {awaitingIndicator(awaiting) === 'spinner'
                ? <Spinner size={10} className="thread-awaiting-input-spinner" />
                : <span className="thread-awaiting-input-dot" />}
        </span>
    </Tooltip>
);

export default AwaitingInputDot;
