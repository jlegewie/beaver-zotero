import { AgentRun, TextPart, ToolCallPart } from '../agents/types';
import { getToolCallLabel } from '../agents/toolLabels';
import { isToolResultView } from '../types/toolResultViews';

/**
 * Parse args from a ToolCallPart, handling both string and object formats.
 */
function parseToolCallArgs(part: ToolCallPart): Record<string, unknown> {
    if (!part.args) return {};
    if (typeof part.args === 'object') return part.args as Record<string, unknown>;
    if (typeof part.args === 'string') {
        try { return JSON.parse(part.args); } catch { return {}; }
    }
    return {};
}

/**
 * Extract tool call details as a formatted string.
 * Moved from AgentRunFooter's inline getToolDetails closure.
 */
export function getToolCallDetails(
    part: ToolCallPart,
    toolResultsMap: Map<string, any>
): string {
    // The view-derived label already bakes in the name/locator and the count
    // suffix, so we don't append a separate result count here (that would
    // double-count). Scope names for list_* tools are not host-resolved in this
    // export path; the label degrades to the raw arg.
    const result = toolResultsMap.get(part.tool_call_id);
    const view = result?.part_kind === 'tool-return' && isToolResultView(result.metadata?.view)
        ? result.metadata.view
        : null;
    const label = getToolCallLabel(part, 'completed', { view });
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

    let details = `[${label}`;
    if (query) details += `: "${query}"`;
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
                    .map(p => {
                        // For create_note, include the note content inline (like <note> tags)
                        if (p.tool_name === 'create_note') {
                            const args = parseToolCallArgs(p);
                            const title = args.title as string | undefined;
                            const content = args.content as string | undefined;
                            if (title && content) {
                                // Match preprocessNoteContent output: blank lines around --- to
                                // ensure they are thematic breaks (not setext headings)
                                return `\n\n---\n## ${title}\n\n${content}\n\n---`;
                            }
                        }
                        return getToolCallDetails(p, toolResultsMap);
                    })
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
    /** Wrap user messages in blockquotes (for note saves) */
    userMessageAsBlockquote?: boolean;
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
    const { threadName, threadId, includeRunLinks = true, userMessageAsBlockquote = false } = options;
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
            const formattedMessage = userMessageAsBlockquote
                ? `> ${userMessage.replace(/\n/g, '\n> ')}`
                : userMessage;
            sections.push(`## ${userHeading}\n\n${formattedMessage}`);
        }
        if (responseContent) {
            sections.push(`## Beaver\n\n${responseContent}`);
        }
    }

    return sections.join('\n\n---\n\n');
}
