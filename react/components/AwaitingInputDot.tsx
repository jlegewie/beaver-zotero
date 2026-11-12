import React from 'react';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { awaitingInputLabel, type AwaitingInput } from '../../src/services/threads/awaitingInput';

/**
 * Marks a chat in a thread list whose parked run waits on the user's
 * answers; the tooltip says what it waits on. Hidden from screen readers:
 * the row's label carries the same text.
 */
const AwaitingInputDot: React.FC<{ awaiting: AwaitingInput }> = ({ awaiting }) => (
    <Tooltip content={awaitingInputLabel(awaiting)} singleLine anchorDisplay="inline-flex">
        <span className="thread-awaiting-input" aria-hidden="true">
            <span className="thread-awaiting-input-dot" />
        </span>
    </Tooltip>
);

export default AwaitingInputDot;
