import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { PendingTableCard } from '@beaver/agent-core/run-state/pendingTableCards';
import type { WSTableCardResponse } from '@beaver/agent-core/protocol/tableCardProtocol';
import { RECONNECT_HELD_CAPTION } from '@beaver/agent-core/transport/connectionFailure';
import { isRunReconnectingAtom, sendTableCardResponseAtom } from '../../../atoms/agentRunAtoms';
import { useStopRun } from '../../../hooks/useStopRun';
import { useRunReconnectShown } from '../../../hooks/useVisibleReconnect';
import TableCard from './TableCard';

interface TableCardPanelProps {
    card: PendingTableCard;
}

/**
 * Composer takeover for a pending table card.
 *
 * Rendered by Sidebar instead of InputArea while `create_table` waits for the
 * user, so the proposal sits where the user is already looking. The draft
 * message is untouched. The answer travels back over the run's connection,
 * correlated on the card id; while that connection is being recovered the
 * card holds its answer back and offers Stop instead.
 */
export const TableCardPanel: React.FC<TableCardPanelProps> = ({ card }) => {
    const send = useSetAtom(sendTableCardResponseAtom);
    const isReconnecting = useAtomValue(isRunReconnectingAtom);
    const reconnectShown = useRunReconnectShown();
    const handleStop = useStopRun('TableCardPanel');
    const handleSubmit = useCallback((response: WSTableCardResponse) => send(response), [send]);

    return (
        <TableCard
            request={card}
            onSubmit={handleSubmit}
            disabled={isReconnecting}
            heldCaption={reconnectShown ? RECONNECT_HELD_CAPTION : undefined}
            onStop={handleStop}
        />
    );
};

export default TableCardPanel;
