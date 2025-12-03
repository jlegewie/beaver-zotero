import React from 'react';
import { ChatMessage } from '../../types/chat/uiTypes';
import { useAtomValue } from 'jotai';
import { getProposedActionsByMessageAtom } from '../../atoms/proposedActions';
import { isChatRequestPendingAtom } from '../../atoms/threads';
import CreateItemToolDisplay from './CreateItemToolDisplay';
import { isCreateItemAction } from '../../types/proposedActions/base';
import { CreateItemProposedAction } from '../../types/proposedActions/items';


interface ProposedActionsDisplayProps {
    messages: ChatMessage[];
}

const ProposedActionsDisplay: React.FC<ProposedActionsDisplayProps> = ({
    messages
}) => {
    // If the chat request is pending or the last message is in progress, don't show the proposed actions
    const isChatRequestPending = useAtomValue(isChatRequestPendingAtom);
    const lastMessage = messages[messages.length - 1];
    if (isChatRequestPending || lastMessage.status === 'in_progress') {
        return null;
    }

    // Get proposed actions: create item actions from citations
    const getProposedActionsByMessageId = useAtomValue(getProposedActionsByMessageAtom);
    const proposedActions = getProposedActionsByMessageId(
        lastMessage.id,
        (action) => isCreateItemAction(action) && action.toolcall_id == 'citations'
    ) as CreateItemProposedAction[];
    console.log("proposedActions", proposedActions)

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