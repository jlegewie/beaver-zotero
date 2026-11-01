import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { PendingTableCard } from '@beaver/agent-core/run-state/pendingTableCards';
import { isCreateCard, isFillCard, type WSTableCardResponse } from '@beaver/agent-core/protocol/tableCardProtocol';
import { RECONNECT_HELD_CAPTION } from '@beaver/agent-core/transport/connectionFailure';
import { isRunReconnectingAtom, sendTableCardResponseAtom } from '../../../atoms/agentRunAtoms';
import { useStopRun } from '../../../hooks/useStopRun';
import { useRunReconnectShown } from '../../../hooks/useVisibleReconnect';
import TableCard from './TableCard';
import TableFillCard from './TableFillCard';

interface TableCardPanelProps {
    card: PendingTableCard;
}

/**
 * Composer takeover for a pending table card.
 *
 * Rendered by Sidebar instead of InputArea while `create_table` or
 * `fill_table` waits for the user, so the proposal sits where the user is
 * already looking. The draft message is untouched. The answer travels back over the run's connection,
 * correlated on the card id; while that connection is being recovered the
 * card holds its answer back and offers Stop instead.
 */
export const TableCardPanel: React.FC<TableCardPanelProps> = ({ card }) => {
    const send = useSetAtom(sendTableCardResponseAtom);
    const isReconnecting = useAtomValue(isRunReconnectingAtom);
    const reconnectShown = useRunReconnectShown();
    const handleStop = useStopRun('TableCardPanel');
    const handleSubmit = useCallback((response: WSTableCardResponse) => send(response), [send]);

    const held = reconnectShown ? RECONNECT_HELD_CAPTION : undefined;
    if (isFillCard(card))
        return (
            <TableFillCard request={card} onSubmit={handleSubmit} disabled={isReconnecting} heldCaption={held} onStop={handleStop} />
        );
    // Any other card was declined when it arrived.
    if (!isCreateCard(card)) return null;
    return (
        <TableCard request={card} onSubmit={handleSubmit} disabled={isReconnecting} heldCaption={held} onStop={handleStop} />
    );
};

export default TableCardPanel;
