import React from 'react';
import { ToolCallPart, AgentRunStatus } from '../../agents/types';
import { TOOL_BASE_LABELS, parseArgs } from '../../agents/toolCallRequest';

/**
 * Client-agnostic fallback for agent-action tool calls.
 *
 * Renders a read-only, request-side summary of an agent action (what the agent
 * *did* / proposed) from the tool-call args alone — used when the host provides
 * no client-specific agent-action UI (non-Zotero clients) or for an action call
 * with no rich view (e.g. a failed call). It is deliberately minimal and makes
 * NO host call:
 *  - no view model (agent actions have none) and never switches to one;
 *  - no item-name resolution (that is the tool-call LABEL layer's job, not this);
 *  - no apply/undo controls (a client without the host slice cannot mutate Zotero).
 *
 * Stays free of `Zotero.*`/`getHost()` so it can live under the render-layer lint
 * guard. The rich Zotero apply/undo UI is injected via `getHost().components`.
 */

interface GenericAgentActionViewProps {
    /** A single action tool-call (tool-action / annotation surfaces). */
    part?: ToolCallPart;
    /** An edit_note group (one row per edit). */
    editNoteParts?: ToolCallPart[];
    runStatus?: AgentRunStatus;
    /** Partial args while a tool call is still streaming. */
    streamingArgs?: Record<string, unknown> | null;
}

/** Humanize an unknown tool name ("create_note" → "Create note"). */
function humanizeToolName(toolName: string): string {
    const spaced = toolName.replace(/[_-]+/g, ' ').trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Action';
}

function baseLabel(toolName: string): string {
    return TOOL_BASE_LABELS[toolName] ?? humanizeToolName(toolName);
}

/** Best-effort, request-side one-line detail for common agent actions. */
function summarizeArgs(toolName: string, args: Record<string, unknown>): string | null {
    const countOf = (value: unknown): number | null =>
        Array.isArray(value) ? value.length : null;

    switch (toolName) {
        case 'create_highlight_annotations':
        case 'create_note_annotations':
        case 'add_highlight_annotations':
        case 'add_note_annotations': {
            const n = countOf(args.annotations);
            return n != null ? `${n} ${n === 1 ? 'annotation' : 'annotations'}` : null;
        }
        case 'create_items':
        case 'create_item': {
            const n = countOf(args.items);
            if (n != null) return `${n} ${n === 1 ? 'item' : 'items'}`;
            const title = typeof args.title === 'string' ? args.title : null;
            return title || null;
        }
        case 'create_note': {
            const title = typeof args.title === 'string' ? args.title : null;
            return title || null;
        }
        case 'edit_note': {
            // The batch-capable backend still calls the model-facing tool
            // "edit_note", but request args carry an ordered edits[] array
            // instead of flat old_string/new_string fields.
            if (Array.isArray(args.edits)) {
                const n = args.edits.length;
                const first = args.edits[0] as Record<string, unknown> | undefined;
                const firstOp = first && typeof first.operation === 'string'
                    ? first.operation.replace(/_/g, ' ')
                    : null;
                const countLabel = `${n} ${n === 1 ? 'edit' : 'edits'}`;
                return firstOp ? `${countLabel} (${firstOp})` : countLabel;
            }
            const op = typeof args.operation === 'string' ? args.operation : null;
            return op ? op.replace(/_/g, ' ') : null;
        }
        case 'manage_tags':
        case 'manage_collections':
        case 'organize_items': {
            const action = typeof args.action === 'string' ? args.action : null;
            const name = typeof args.name === 'string' ? args.name : null;
            return [action, name].filter(Boolean).join(': ') || null;
        }
        default:
            return null;
    }
}

const ActionRow: React.FC<{ part: ToolCallPart; streamingArgs?: Record<string, unknown> | null }> = ({
    part,
    streamingArgs,
}) => {
    const args = streamingArgs ?? parseArgs(part);
    const detail = summarizeArgs(part.tool_name, args);
    return (
        <div className="display-flex flex-row gap-2 items-baseline min-w-0 px-15 py-15">
            <div className="text-sm font-color-secondary whitespace-nowrap">
                {baseLabel(part.tool_name)}
            </div>
            {detail && (
                <div className="text-sm font-color-tertiary truncate min-w-0">
                    {detail}
                </div>
            )}
        </div>
    );
};

export const GenericAgentActionView: React.FC<GenericAgentActionViewProps> = ({
    part,
    editNoteParts,
    streamingArgs,
}) => {
    const parts = editNoteParts ?? (part ? [part] : []);
    if (parts.length === 0) return null;

    return (
        <div className="display-flex flex-col min-w-0">
            {parts.map((p, index) => (
                <ActionRow
                    key={`${p.tool_call_id}-${index}`}
                    part={p}
                    streamingArgs={editNoteParts ? undefined : streamingArgs}
                />
            ))}
        </div>
    );
};

export default GenericAgentActionView;
