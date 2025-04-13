import { MessageAttachment, MessageModel, ToolCall } from './api';
import { ChatMessage } from '../messages';

// export function toMessageUI(message: Message): MessageUI {
export function toMessageUI(message: MessageModel): ChatMessage {
    const chatMessage: ChatMessage = {
        id: message.id,
        role: message.role,
        content: message.content || '',
        status: message.status,
        tool_calls: message.tool_calls,
    } as ChatMessage;
    if (message.error) {
        const errorParts = message.error.split(':');
        if (errorParts.length > 0) {
            chatMessage.errorType = errorParts[0];
        }
    }
    return chatMessage;
}

function isMessageAttachment(obj: any): obj is MessageAttachment {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.library_id === 'number' &&
        typeof obj.zotero_key === 'string'
    );
}

export function getResultAttachments(toolCall: ToolCall): MessageAttachment[] {
    if (!toolCall.response) {
        return [];
    }

    const attachments = toolCall.response.attachments || [];

    return attachments.map((att: any) => {
        if (isMessageAttachment(att)) {
            return att;
        } else {
            // If the attachment doesn't match the interface, try to create a valid MessageAttachment
            return {
                library_id: typeof att.library_id === 'number' ? att.library_id : 0,
                zotero_key: typeof att.zotero_key === 'string' ? att.zotero_key : ''
            };
        }
    });
}