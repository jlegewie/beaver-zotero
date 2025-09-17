import { MessageModel, ToolCall } from './apiTypes';
import { ChatMessage } from '../chat/uiTypes';
import { SourceAttachment, MessageAttachment } from '../attachments/apiTypes';
import {
    isAnnotationTool,
    mergeAnnotations,
    toAnnotationValidationSummary,
} from './toolAnnotations';

// export function toMessageUI(message: Message): MessageUI {
export function toMessageUI(message: MessageModel): ChatMessage {
    const chatMessage: ChatMessage = {
        id: message.id,
        role: message.role,
        content: message.content || '',
        reasoning_content: message.reasoning_content || '',
        status: message.status,
        tool_calls: message.tool_calls,
    } as ChatMessage;

    if (message.tool_calls && message.tool_calls.length > 0) {
        chatMessage.tool_calls = message.tool_calls.map((toolcall) => {
            const normalized: ToolCall = {
                ...toolcall,
                response: toolcall.response ? { ...toolcall.response } : undefined,
            };

            if (isAnnotationTool(toolcall.function?.name)) {
                const rawMetadata = toolcall.response?.metadata;
                if (rawMetadata) {
                    const summary = toAnnotationValidationSummary(rawMetadata);
                    const mergedAnnotations = mergeAnnotations(toolcall.annotations, summary.annotations);
                    normalized.annotations = mergedAnnotations;
                    normalized.annotationSummary = {
                        ...summary,
                        annotations: mergedAnnotations,
                    };
                }
            }

            return normalized;
        });
    }
    if (message.error) {
        const errorParts = message.error.split(':');
        if (errorParts.length > 0) {
            chatMessage.errorType = errorParts[0];
        }
    }
    return chatMessage;
}

function isSourceAttachment(obj: any): obj is SourceAttachment {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.library_id === 'number' &&
        typeof obj.zotero_key === 'string' &&
        typeof obj.type === 'string' &&
        typeof obj.include === 'string' &&
        obj.type === 'source'
    );
}

export function getResultAttachmentsFromToolcall(toolCall: ToolCall): SourceAttachment[] {
    if (!toolCall.response) {
        return [];
    }

    const attachments = toolCall.response.attachments || [];

    return attachments.map((att: any) => {
        if (isSourceAttachment(att)) {
            return att;
        } else {
            // If the attachment doesn't match the interface, try to create a valid SourceAttachment
            return {
                type: 'source',
                library_id: typeof att.library_id === 'number' ? att.library_id : 0,
                zotero_key: typeof att.zotero_key === 'string' ? att.zotero_key : '',
                include: 'fulltext',
            };
        }
    });
}
