import { AgentRun, TextPart, ToolCallPart } from '@beaver/agent-core/agents/types';
import { isRenderableMessage } from '@beaver/agent-core/agents/messageVisibility';
import { getToolCallLabel, toolCallSearchText, type ToolCallLabelEnrich } from '@beaver/agent-core/run-state/toolLabels';
import { parseArgs } from '@beaver/agent-core/run-state/toolCallRequest';
import { isToolResultView } from '@beaver/agent-core/run-state/toolResultViews';

/**
 * Extract tool call details as a formatted string.
 *
 * `enrichMap` carries the host-resolved names the view model does not supply
 * (library/collection scope names for list_* tools, item names for pending or
 * failed calls), keyed by tool_call_id — see `resolveToolCallLabelEnrichMap`.
 * Without it the label degrades to the raw arg (a library ref like "u").
 */
export function getToolCallDetails(
    part: ToolCallPart,
    toolResultsMap: Map<string, any>,
    enrichMap?: Map<string, ToolCallLabelEnrich> | null
): string {
    // The view-derived label already bakes in the name/locator and the count
    // suffix, so we don't append a separate result count here (that would
    // double-count).
    const result = toolResultsMap.get(part.tool_call_id);
    const view = result?.part_kind === 'tool-return' && isToolResultView(result.metadata?.view)
        ? result.metadata.view
        : null;
    const label = getToolCallLabel(part, 'completed', {
        view,
        enrich: enrichMap?.get(part.tool_call_id) ?? null,
    });
    // Database searches and lookups: their full search, which the label may cut.
    const args = parseArgs(part);
    const raw = toolCallSearchText(part, view)
        ?? (args.query || args.q || args.keywords || args.topic || args.search_term);
    const query = (Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : '').trim();

    let details = `[${label}`;
    // Copied text keeps the full query; skip it only when the label already shows all of it.
    if (query && !label.includes(query)) details += `: "${query}"`;
    details += `]`;
    return details;
}

/**
 * Extract combined text + tool descriptions from a single run's model_messages.
 * Moved from AgentRunFooter's combinedContent useMemo.
 */
export function extractRunResponseContent(
    run: AgentRun,
    toolResultsMap: Map<string, any>,
    enrichMap?: Map<string, ToolCallLabelEnrich> | null
): string {
    const parts: string[] = [];

    for (const message of run.model_messages) {
        // Copied/saved content is user-facing, so the same rule applies here as
        // on screen (see `isRenderableMessage`).
        if (isRenderableMessage(message)) {
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
                        // For create_note, include the note content inline
                        if (p.tool_name === 'create_note') {
                            const args = parseArgs(p);
                            const title = args.title as string | undefined;
                            const content = args.content as string | undefined;
                            if (title && content) {
                                // Match preprocessNoteContent output: blank lines around --- to
                                // ensure they are thematic breaks (not setext headings)
                                return `\n\n---\n## ${title}\n\n${content}\n\n---`;
                            }
                        }
                        return getToolCallDetails(p, toolResultsMap, enrichMap);
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
    /** Host-resolved tool-call label names, keyed by tool_call_id */
    enrichMap?: Map<string, ToolCallLabelEnrich> | null;
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
    const { threadName, threadId, includeRunLinks = true, userMessageAsBlockquote = false, enrichMap } = options;
    const sections: string[] = [];

    if (threadName) {
        sections.push(`# ${threadName}`);
    }

    for (const run of runs) {
        const userMessage = run.user_prompt.content;
        const responseContent = extractRunResponseContent(run, toolResultsMap, enrichMap);

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
