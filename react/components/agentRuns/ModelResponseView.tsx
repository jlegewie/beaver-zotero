import React, { useRef } from 'react';
import { AgentRunStatus, ModelResponse, ToolCallPart } from '../../agents/types';
import { TextPartView } from './TextPartView';
import { ThinkingPartView } from './ThinkingPartView';
import { ToolCallPartView } from './ToolCallPartView';
import { AnnotationToolCallView } from './AnnotationToolCallView';
import { EditNoteGroupView } from './EditNoteGroupView';
import { isAnnotationToolResult } from '../../agents/toolResultTypes';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';

/**
 * Render item for the tool-call iteration in a model response.
 *
 * Consecutive `edit_note` parts targeting the same note are folded into one
 * `edit-note-group` so the chat shows a single "X Edits · Note Title" row
 * instead of one row per parallel tool call.
 */
type RenderItem =
    | { kind: 'single'; part: ToolCallPart }
    | {
        kind: 'edit-note-group';
        libraryId: number;
        zoteroKey: string;
        parts: ToolCallPart[];
    };

/**
 * Extract `(library_id, zotero_key)` from a `ToolCallPart`'s args. Returns
 * null when the args aren't a complete edit_note payload (e.g. mid-stream
 * unparseable JSON, or missing fields).
 *
 * The `edit_note` tool schema uses a combined `note_id` field of the form
 * `"<library_id>-<zotero_key>"`. We also accept the separate
 * `library_id` / `zotero_key` shape as a fallback in case the backend
 * normalizes one form to the other in the future.
 */
function getEditNoteTarget(part: ToolCallPart): { libraryId: number; zoteroKey: string } | null {
    if (part.tool_name !== 'edit_note') return null;
    if (isAnnotationToolResult(part.tool_name)) return null;

    let args: Record<string, unknown> | undefined;
    try {
        args = typeof part.args === 'string'
            ? (part.args ? JSON.parse(part.args) : undefined)
            : (part.args as Record<string, unknown> | undefined) ?? undefined;
    } catch {
        return null;
    }

    if (!args) return null;

    // Preferred: combined note_id of the form "<libraryId>-<zoteroKey>"
    const noteId = args.note_id;
    if (typeof noteId === 'string' && noteId) {
        const dashIdx = noteId.indexOf('-');
        if (dashIdx > 0 && dashIdx < noteId.length - 1) {
            const libraryId = parseInt(noteId.substring(0, dashIdx), 10);
            const zoteroKey = noteId.substring(dashIdx + 1);
            if (Number.isFinite(libraryId) && zoteroKey) {
                return { libraryId, zoteroKey };
            }
        }
    }

    // Fallback: separate library_id / zotero_key fields
    const libRaw = args.library_id;
    const keyRaw = args.zotero_key;
    const libraryId = typeof libRaw === 'number'
        ? libRaw
        : (typeof libRaw === 'string' ? parseInt(libRaw, 10) : NaN);
    if (Number.isFinite(libraryId) && typeof keyRaw === 'string' && keyRaw) {
        return { libraryId, zoteroKey: keyRaw };
    }

    return null;
}

/**
 * Walk the tool-call parts left-to-right, folding consecutive `edit_note`
 * parts that target the same note into a group. A run of length 1 stays as
 * a `single` item so single edits render exactly as before.
 */
function buildRenderItems(parts: ToolCallPart[]): RenderItem[] {
    const items: RenderItem[] = [];
    let runParts: ToolCallPart[] = [];
    let runLib: number | null = null;
    let runKey: string | null = null;

    const flushRun = () => {
        if (runParts.length === 0) return;
        if (runParts.length >= 2 && runLib !== null && runKey !== null) {
            items.push({
                kind: 'edit-note-group',
                libraryId: runLib,
                zoteroKey: runKey,
                parts: runParts,
            });
        } else {
            for (const p of runParts) items.push({ kind: 'single', part: p });
        }
        runParts = [];
        runLib = null;
        runKey = null;
    };

    for (const part of parts) {
        const target = getEditNoteTarget(part);
        if (target) {
            if (runLib === target.libraryId && runKey === target.zoteroKey) {
                runParts.push(part);
            } else {
                flushRun();
                runParts = [part];
                runLib = target.libraryId;
                runKey = target.zoteroKey;
            }
        } else {
            flushRun();
            items.push({ kind: 'single', part });
        }
    }
    flushRun();

    return items;
}

interface ModelResponseViewProps {
    /** The model response */
    message: ModelResponse;
    /** Whether the response is streaming */
    isStreaming: boolean;
    /** Whether the previous message has a tool call */
    previousMessageHasToolCall: boolean;
    /** Run ID for element identification */
    runId: string;
    /** Index of this response within the run (for unique DOM IDs) */
    responseIndex: number;
    /** Run status */
    runStatus: AgentRunStatus;
}

/**
 * Renders a single model response with all its parts.
 * Parts are rendered in order: thinking, text, and tool calls.
 */
export const ModelResponseView: React.FC<ModelResponseViewProps> = ({
    message,
    isStreaming,
    previousMessageHasToolCall,
    runId,
    responseIndex,
    runStatus,
}) => {
    const contentRef = useRef<HTMLDivElement | null>(null);
    
    const { 
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    // Separate parts by type for rendering
    const thinkingParts = message.parts.filter(part => part.part_kind === 'thinking');
    const textParts = message.parts.filter(part => part.part_kind === 'text');
    const toolCallParts = message.parts.filter(part => part.part_kind === 'tool-call' && part.tool_name !== 'return_suggestions');

    // Check if we have any visible content
    const hasContent = thinkingParts.length > 0 || textParts.length > 0 || toolCallParts.length > 0;

    if (!hasContent) {
        return null;
    }

    // Generate a unique ID for this response (used for DOM identification and UI state persistence)
    // Note: This is NOT used for proposed actions - those will use runId directly once migrated
    const responseId = `${runId}-response-${responseIndex}`;

    return (
        <div
            id={`response-${responseId}`}
            className={`hover-trigger user-select-text ${previousMessageHasToolCall ? '-mt-1' : ''}`}
            ref={contentRef}
            onContextMenu={handleContextMenu}
        >
            {/* Thinking parts (collapsible) */}
            {thinkingParts.length > 0 && (
                <ThinkingPartView
                    key={`${responseId}-thinking`}
                    parts={thinkingParts}
                    isThinking={isStreaming && textParts.length === 0 && toolCallParts.length === 0}
                    hasFollowingContent={textParts.length > 0 || toolCallParts.length > 0}
                    thinkingId={`${responseId}-thinking`}
                />
            )}

            {/* Text parts (markdown rendered) */}
            {textParts.map((part, index) => (
                part.part_kind === 'text' && (
                    <TextPartView
                        key={`text-${index}`}
                        part={part}
                        runId={runId}
                    />
                )
            ))}

            {/* Tool call parts */}
            {toolCallParts.length > 0 && (
                <div className="display-flex flex-col py-2 gap-1">
                    {buildRenderItems(toolCallParts as ToolCallPart[]).map((item) => {
                        if (item.kind === 'edit-note-group') {
                            return (
                                <EditNoteGroupView
                                    key={`edit-note-group-${item.libraryId}-${item.zoteroKey}-${item.parts[0].tool_call_id}`}
                                    parts={item.parts}
                                    libraryId={item.libraryId}
                                    zoteroKey={item.zoteroKey}
                                    runId={runId}
                                    responseIndex={responseIndex}
                                    runStatus={runStatus}
                                />
                            );
                        }

                        const part = item.part;

                        // Use specialized view for annotation tools
                        if (isAnnotationToolResult(part.tool_name)) {
                            return (
                                <AnnotationToolCallView
                                    key={`tool-${part.tool_call_id}`}
                                    part={part}
                                    runId={runId}
                                    runStatus={runStatus}
                                />
                            );
                        }

                        // Default view for other tools
                        return (
                            <ToolCallPartView
                                key={`tool-${responseIndex}-${part.tool_call_id}`}
                                part={part}
                                runId={runId}
                                responseIndex={responseIndex}
                                runStatus={runStatus}
                            />
                        );
                    })}
                </div>
            )}

            {/* Text selection context menu */}
            <ContextMenu
                menuItems={selectionMenuItems}
                isOpen={isSelectionMenuOpen}
                onClose={closeSelectionMenu}
                position={selectionMenuPosition}
                useFixedPosition={true}
            />
        </div>
    );
};

export default ModelResponseView;

