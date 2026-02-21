import { AgentRun, TextPart, ToolCallPart } from '../agents/types';
import { getToolCallLabel } from '../agents/toolLabels';

/**
 * Extract tool call details as a formatted string.
 * Moved from AgentRunFooter's inline getToolDetails closure.
 */
export function getToolCallDetails(
    part: ToolCallPart,
    toolResultsMap: Map<string, any>
): string {
    const label = getToolCallLabel(part, 'completed');
    let query = "";
    try {
        const args = typeof part.args === 'object' && part.args
            ? part.args
            : typeof part.args === 'string' && part.args.startsWith('{')
                ? JSON.parse(part.args)
                : {};
        query = args.search_label || args.query || args.q || args.keywords || args.topic || args.search_term || "";
    } catch (e) {
        console.error('Error parsing tool call arguments:', e);
    }

    const result = toolResultsMap.get(part.tool_call_id);
    const count = result && result.part_kind === 'tool-return'
        ? result?.metadata?.summary?.result_count ?? null
        : null;

    let details = `[${label}`;
    if (query) details += `: "${query}"`;
    if (result && count !== null) details += ` (${count} results)`;
    details += `]`;
    return details;
}

/**
 * Extract combined text + tool descriptions from a single run's model_messages.
 * Moved from AgentRunFooter's combinedContent useMemo.
 */
export function extractRunResponseContent(
    run: AgentRun,
    toolResultsMap: Map<string, any>
): string {
    const parts: string[] = [];

    for (const message of run.model_messages) {
        if (message.kind === 'response') {
            const textContent = message.parts
                .filter((part): part is TextPart => part.part_kind === 'text')
                .map(part => part.content)
                .filter(Boolean)
                .join('\n\n');

            if (textContent) {
                parts.push(textContent);
            }

            const toolCallParts = message.parts.filter(
                (part): part is ToolCallPart => part.part_kind === 'tool-call'
            );
            if (toolCallParts.length > 0) {
                const toolDescriptions = toolCallParts
                    .map(p => getToolCallDetails(p, toolResultsMap))
                    .join('\n\n');
                parts.push(toolDescriptions);
            }
        }
    }

    return parts.filter(Boolean).join('\n\n');
}

/**
 * Combine all runs in a thread into a single conversation-formatted string.
 * Each run's user message is prefixed with **User:** and separated by ---
 */
export function extractThreadContent(
    runs: AgentRun[],
    toolResultsMap: Map<string, any>
): string {
    const sections: string[] = [];

    for (const run of runs) {
        const userMessage = run.user_prompt.content;
        const responseContent = extractRunResponseContent(run, toolResultsMap);

        const parts: string[] = [];
        if (userMessage) {
            parts.push(`**User:** ${userMessage}`);
        }
        if (responseContent) {
            parts.push(responseContent);
        }

        if (parts.length > 0) {
            sections.push(parts.join('\n\n'));
        }
    }

    return sections.join('\n\n---\n\n');
}
