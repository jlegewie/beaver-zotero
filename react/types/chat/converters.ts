import { MessageModel } from './api';
import { ChatMessage } from '../messages';

// export function toMessageUI(message: Message): MessageUI {
export function toMessageUI(message: MessageModel): ChatMessage {
    return {
        id: message.id,
        role: message.role,
        content: message.content || '',
        status: message.status,
        tool_calls: message.tool_calls,
    } as ChatMessage;
}
