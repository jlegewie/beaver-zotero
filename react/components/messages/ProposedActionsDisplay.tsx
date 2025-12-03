import React from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { useAtomValue } from 'jotai';
import { getProposedActionsByMessageAtom } from '../../atoms/proposedActions';
import CreateItemToolDisplay from './CreateItemToolDisplay';
import { isCreateItemAction } from '../../types/proposedActions/base';
import { CreateItemProposedAction } from '../../types/proposedActions/items';


interface ProposedActionsDisplayProps {
    messages: ChatMessage[];
}

const ProposedActionsDisplay: React.FC<ProposedActionsDisplayProps> = ({
    messages
}) => {
    // All hooks must be called before any conditional returns
    const getProposedActionsByMessageId = useAtomValue(getProposedActionsByMessageAtom);

    const lastMessage = messages[messages.length - 1];

    // Get proposed actions: create item actions from citations
    const proposedActions = getProposedActionsByMessageId(
        lastMessage.id,
        (action) => isCreateItemAction(action) && action.toolcall_id == 'citations'
    ) as CreateItemProposedAction[];

    // If the chat request is pending or the last message is in progress, don't show the proposed actions
    if (lastMessage.status === 'in_progress') {
        return null;
    }

    if (
        proposedActions.length === 0 ||
        proposedActions.every((action) => action.status === 'rejected' || action.status === 'undone' || action.status === 'error')
        // proposedActions.some((action) => action.status === 'pending')
    ) {
        return null;
    }

    return (
        <CreateItemToolDisplay
            messageId={lastMessage.id}
            createItemActions={proposedActions}
        />
    );
};

export default ProposedActionsDisplay;