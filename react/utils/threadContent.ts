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

export interface ExtractThreadContentOptions {
    /** Thread title to use as H1 heading */
    threadName?: string | null;
    /** Thread ID for building per-run deep links */
    threadId?: string | null;
    /** Include per-run [↗] deep links (works in clipboard markdown, not in Zotero notes) */
    includeRunLinks?: boolean;
}

/**
 * Combine all runs in a thread into a conversation-formatted string.
 * Format:
 *   # Thread Title
 *
 *   ## User [↗](zotero://beaver/thread/{threadId}/run/{runId})
 *   <user message>
 *   ---
 *   ## Beaver
 *   <response>
 *   ---
 */
export function extractThreadContent(
    runs: AgentRun[],
    toolResultsMap: Map<string, any>,
    options: ExtractThreadContentOptions = {}
): string {
    const { threadName, threadId, includeRunLinks = true } = options;
    const sections: string[] = [];

    if (threadName) {
        sections.push(`# ${threadName}`);
    }

    for (const run of runs) {
        const userMessage = run.user_prompt.content;
        const responseContent = extractRunResponseContent(run, toolResultsMap);

        if (userMessage) {
            const userHeading = includeRunLinks && threadId
                ? ` [User ↗](zotero://beaver/thread/${threadId}/run/${run.id})`
                : 'User';
            sections.push(`## ${userHeading}\n\n${userMessage}`);
        }
        if (responseContent) {
            sections.push(`## Beaver\n\n${responseContent}`);
        }
    }

    return sections.join('\n\n---\n\n');
}
