import { AgentRun, TextPart } from '../agents/types';

const MAX_RESPONSE_ANNOUNCEMENT_CHARS = 4000;

function decodeBasicHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'");
}

/**
 * Convert assistant markdown-ish content into text suitable for a live region.
 */
export function toScreenReaderText(text: string): string {
    return decodeBasicHtmlEntities(text)
        .replace(/<note\s+[^>]*title=["']([^"']+)["'][^>]*>/gi, '\n$1\n')
        .replace(/<\/note>/gi, '\n')
        .replace(/<citation\b[^>]*\/?>/gi, '')
        .replace(/<\/citation>/gi, '')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/```[\s\S]*?```/g, (match) => match.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/^[ \t]*[-*+]\s+/gm, '')
        .replace(/^[ \t]*\d+\.\s+/gm, '')
        .replace(/[*_~]{1,3}/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract the assistant's visible text response from a run.
 */
export function extractAssistantResponseText(run: AgentRun): string {
    const textParts: string[] = [];

    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'text') {
                textParts.push((part as TextPart).content);
            }
        }
    }

    return toScreenReaderText(textParts.filter(Boolean).join('\n\n'));
}

function countWords(text: string): number {
    if (!text.trim()) return 0;
    return text.trim().split(/\s+/).length;
}

/**
 * Build the final announcement for a run when it leaves the active state.
 */
export function buildRunCompletionAnnouncement(run: AgentRun): string | null {
    if (run.status === 'completed') {
        const responseText = extractAssistantResponseText(run);
        if (!responseText) {
            return 'Response complete.';
        }
        if (responseText.length > MAX_RESPONSE_ANNOUNCEMENT_CHARS) {
            return `Response complete. Beaver wrote about ${countWords(responseText)} words. Navigate to the latest message to read it.`;
        }
        return `Beaver response: ${responseText}`;
    }

    if (run.status === 'error') {
        const message = run.error?.message ? toScreenReaderText(run.error.message) : 'Unknown error.';
        const punctuatedMessage = /[.!?]$/.test(message) ? message : `${message}.`;
        return `Beaver response failed: ${punctuatedMessage} Press Tab or Enter to move to error actions, or Escape to message Beaver.`;
    }

    if (run.status === 'canceled') {
        return 'Response canceled.';
    }

    return null;
}
