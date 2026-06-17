import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus, ToolCallPart } from '../../agents/types';
import { toolResultsMapAtom, getToolCallStatus } from '../../agents/atoms';
import { getToolCallLabel, getLabelEnrichmentNeeds, type ToolCallLabelEnrich } from '../../agents/toolLabels';
import { extractZoteroReferencesFromToolCall, parseArgs } from '../../agents/toolCallRequest';
import {
    isToolResultView,
    getToolResultRenderableCount,
    type ToolResultView as ToolResultViewModel,
} from '../../types/toolResultViews';
import { ToolResultView } from './ToolResultView';
import { GenericAgentActionView } from './GenericAgentActionView';
import { getHost } from '../../host';
import { getPendingApprovalForToolcallAtom, getAgentActionsByToolcallAtom } from '../../agents/agentActions';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    SearchIcon,
    ViewIcon,
    Icon,
    PuzzleIcon,
    FileViewIcon,
    GlobalSearchIcon,
    TextAlignLeftIcon,
    DocumentValidationIcon,
    FolderDetailIcon,
    FolderAddIcon,
    DatabaseIcon,
    IdeaIcon,
    TaskDoneIcon,
    TaskDailyIcon,
    TagIcon,
    PropertyEditIcon,
    HighlighterIcon,
} from '../icons/icons';
import { toolExpandedAtom, toggleToolExpandedAtom, setToolExpandedAtom } from '../../atoms/messageUIState';

type IconComponent = React.FC<React.SVGProps<SVGSVGElement>>;

/**
 * Maps tool names to their appropriate icons
 */
const TOOL_ICONS: Record<string, IconComponent> = {
    // Search tools - library search
    item_search: SearchIcon,
    item_search_by_topic: SearchIcon,
    item_search_by_metadata: SearchIcon,
    fulltext_search: SearchIcon,
    fulltext_search_keywords: SearchIcon,
    zotero_search: SearchIcon,

    // List tools - library management
    list_items: TextAlignLeftIcon,
    list_collections: FolderDetailIcon,
    list_tags: TagIcon,
    list_libraries: DatabaseIcon,

    // Metadata tools
    get_metadata: FileViewIcon,
    edit_metadata: PropertyEditIcon,
    edit_item: PropertyEditIcon,

    // Annotation tools
    get_annotations: HighlighterIcon,
    find_annotations: HighlighterIcon,

    // Reading tools
    search_in_documents: TextAlignLeftIcon,
    search_in_attachment: SearchIcon,
    find_in_attachments: SearchIcon,
    read: TextAlignLeftIcon,
    read_pages: TextAlignLeftIcon,
    read_attachment: TextAlignLeftIcon,
    view_page_images: ViewIcon,
    view_pages: ViewIcon,
    view: ViewIcon,

    // Note tools
    read_note: TextAlignLeftIcon,
    edit_note: PropertyEditIcon,
    create_note: DocumentValidationIcon,

    // Extract tool
    extract: TaskDailyIcon,

    // External search tools
    external_search: GlobalSearchIcon,
    lookup_work: GlobalSearchIcon,

    // Create item tool
    create_zotero_item: DocumentValidationIcon,
    create_items: DocumentValidationIcon,

    // Create collection tool
    create_collection: FolderAddIcon,

    // Organize items tool
    organize_items: TaskDoneIcon,

    // Read tool result
    read_file: TextAlignLeftIcon,
    load_tool_results: PuzzleIcon,
    
    // Progressive disclosure tools
    load_capability: PuzzleIcon,
    search_tools: PuzzleIcon,
};

/** Progressive disclosure tools whose returns are framework-internal and shouldn't be expandable. */
const NON_EXPANDABLE_TOOLS = new Set(['read_file', 'load_capability', 'search_tools', 'load_tool_results']);

/** Tools that support streaming argument preview */
const STREAMING_PREVIEW_TOOLS = new Set(['create_note']);

/**
 * Detect the type of file being read by the read_file tool.
 * Simplified version of detectReadFileType from toolLabels.ts
 */
function detectReadFileType(path: string): 'tool_result' | 'skill' | 'skill_resource' | 'documentation' | 'unknown' {
    const pathLower = path.toLowerCase();
    
    if (pathLower.endsWith('.json.gz')) {
        return 'tool_result';
    }
    
    if (pathLower.includes('/skills/')) {
        const fileName = path.split('/').pop()?.toUpperCase();
        if (fileName === 'SKILL.MD') {
            return 'skill';
        }
        
        const parts = pathLower.split('/skills/');
        if (parts.length > 1) {
            const skillPath = parts[1];
            const pathSegments = skillPath.split('/');
            if (pathSegments.length > 1 && ['scripts', 'references', 'assets'].includes(pathSegments[1])) {
                return 'skill_resource';
            }
        }
        
        return 'skill';
    }
    
    if (pathLower.includes('/docs/')) {
        return 'documentation';
    }
    
    return 'unknown';
}

/**
 * Get the icon for a tool based on its name and arguments
 */
function getToolIcon(part: ToolCallPart): IconComponent {
    const toolName = part.tool_name;
    
    // Special handling for read_file - check file type
    if (toolName === 'read_file') {
        let args: Record<string, unknown> | undefined;
        try {
            args = typeof part.args === 'string'
                ? JSON.parse(part.args)
                : (part.args as Record<string, unknown>);
        } catch {
            // args may be incomplete while streaming
        }
        const path = args?.path as string | undefined;
        
        if (path) {
            const fileType = detectReadFileType(path);
            if (fileType === 'skill' || fileType === 'skill_resource') {
                return IdeaIcon;
            }
        }
    }
    
    return TOOL_ICONS[toolName] ?? PuzzleIcon;
}

interface ToolCallPartViewProps {
    part: ToolCallPart;
    /** Run ID for global UI state management */
    runId: string;
    /** Index of the parent response message within the run (for unique expansion keys) */
    responseIndex: number;
    /** Run status */
    runStatus: AgentRunStatus;
}

/**
 * Renders a tool call with its status and result.
 * Uses toolResultsMapAtom to look up the result for this tool call.
 * Visibility state is managed globally via searchToolVisibilityAtom.
 * Shows AgentActionView for tools with agent actions (e.g., edit_metadata).
 */
export const ToolCallPartView: React.FC<ToolCallPartViewProps> = ({ part, runId, responseIndex, runStatus }) => {
    const resultsMap = useAtomValue(toolResultsMapAtom);
    const result = resultsMap.get(part.tool_call_id);
    const hasResult = result !== undefined;
    const status = getToolCallStatus(part.tool_call_id, resultsMap, runStatus);

    // Hydrated tool-result view model — present once the call has returned.
    const rawView = result?.part_kind === 'tool-return' ? result.metadata?.view : undefined;
    const view: ToolResultViewModel | null = isToolResultView(rawView) ? rawView : null;
    // Renderable count, for expansion gating only (don't expand a zero-result tool).
    // Prefer the view; fall back to the legacy summary count so view-less returns
    // still block expansion at zero results.
    const renderableCount = view
        ? getToolResultRenderableCount(view)
        : result?.part_kind === 'tool-return'
            ? result.metadata?.summary?.result_count ?? null
            : null;

    // Host-resolved request-side display names for the parts the view model does
    // not cover (pending/failed item names, list_* library/collection scope names).
    // Resolved in an effect via the itemData host slice, mirroring CitedSourcesList;
    // degrades to the base label on clients without that capability.
    const [labelEnrich, setLabelEnrich] = useState<ToolCallLabelEnrich | null>(null);
    useEffect(() => {
        let cancelled = false;
        const itemData = getHost().itemData;
        const needs = getLabelEnrichmentNeeds(part, view);
        if (!itemData || (!needs.itemName && !needs.scope)) {
            setLabelEnrich(null);
            return;
        }
        (async () => {
            const next: ToolCallLabelEnrich = {};
            if (needs.itemName && itemData.resolveItemDisplay) {
                const ref = extractZoteroReferencesFromToolCall(part)[0];
                if (ref) {
                    const display = await itemData.resolveItemDisplay(ref);
                    if (display?.displayName) next.itemDisplayName = display.displayName;
                }
            }
            if (needs.scope) {
                const args = parseArgs(part);
                const libParam = args.library as string | number | undefined;
                const libId = typeof libParam === 'number'
                    ? libParam
                    : (typeof libParam === 'string' ? parseInt(libParam, 10) : undefined);
                const collParam = (args.collection_key ?? args.collection ?? args.parent_collection) as string | undefined;
                if (collParam && itemData.resolveCollectionName) {
                    const name = await itemData.resolveCollectionName(collParam, Number.isNaN(libId as number) ? undefined : libId);
                    if (!cancelled && name) next.collectionName = name;
                }
                if (libParam != null && itemData.resolveLibraryName) {
                    const name = await itemData.resolveLibraryName(libParam);
                    if (!cancelled && name) next.libraryName = name;
                }
            }
            if (!cancelled) setLabelEnrich(Object.keys(next).length ? next : null);
        })();
        return () => { cancelled = true; };
    }, [part.tool_call_id, part.args, view]);

    const label = getToolCallLabel(part, status, { view, enrich: labelEnrich });
    
    // Check for pending approval for this tool call
    const getPendingApproval = useAtomValue(getPendingApprovalForToolcallAtom);
    const pendingApproval = getPendingApproval(part.tool_call_id);
    const isAwaitingApproval = pendingApproval !== null;
    
    // Check for agent actions associated with this tool call
    const getAgentActionsByToolcall = useAtomValue(getAgentActionsByToolcallAtom);
    const agentActions = getAgentActionsByToolcall(part.tool_call_id);
    const hasAgentAction = agentActions.length > 0;
    
    // Determine if this tool should use AgentActionView
    const isStandardAgentActionTool =
        part.tool_name === 'edit_metadata' ||
        part.tool_name === 'create_collection' ||
        part.tool_name === 'create_highlight_annotations' ||
        part.tool_name === 'create_note_annotations' ||
        part.tool_name === 'organize_items' ||
        part.tool_name === 'manage_tags' ||
        part.tool_name === 'manage_collections' ||
        part.tool_name === 'create_items' ||
        part.tool_name === 'create_note';
    const isExtractConfirmApproval =
        part.tool_name === 'extract' &&
        pendingApproval?.actionType === 'confirm_extraction';
    const isExternalSearchConfirmApproval =
        part.tool_name === 'external_search' &&
        pendingApproval?.actionType === 'confirm_external_search';
    const isConfirmApproval = isExtractConfirmApproval || isExternalSearchConfirmApproval;
    const isExtractionRejected =
        part.tool_name === 'extract' &&
        hasResult &&
        result?.content?.status &&
        result?.content?.status === 'REJECTED';
    const isExternalSearchRejected =
        part.tool_name === 'external_search' &&
        hasResult &&
        result?.content?.status &&
        result?.content?.status === 'REJECTED';

    // For extract/external_search, only render AgentActionView while approval is pending.
    // After approval, fall back to normal tool-call rendering so the in-progress spinner stays visible.
    const showAgentActionView =
        (isStandardAgentActionTool && (isAwaitingApproval || hasAgentAction)) ||
        isConfirmApproval;
    const actionToolName = isExtractConfirmApproval
        ? 'confirm_extraction'
        : isExternalSearchConfirmApproval
            ? 'confirm_external_search'
            : part.tool_name;

    // Use global Jotai atom for expansion state (persists across re-renders and syncs between panes)
    const expansionKey = `${runId}:${responseIndex}:${part.tool_call_id}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const toggleExpanded = useSetAtom(toggleToolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const isExpanded = expansionState[expansionKey] ?? false;
    const wasConfirmApprovalRef = useRef(isConfirmApproval);

    // When extract/external_search approval resolves, collapse once so the completed result
    // doesn't auto-expand. Users can still expand manually afterward.
    useEffect(() => {
        const wasConfirmApproval = wasConfirmApprovalRef.current;
        const isConfirmTool = part.tool_name === 'extract' || part.tool_name === 'external_search';
        if (isConfirmTool && wasConfirmApproval && !isConfirmApproval) {
            setExpanded({ key: expansionKey, expanded: false });
        }
        wasConfirmApprovalRef.current = isConfirmApproval;
    }, [part.tool_name, isConfirmApproval, expansionKey, setExpanded]);

    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    const hasError = status === 'error';

    const canExpand =
        hasResult &&
        result?.part_kind === 'tool-return' &&
        // If we can compute a count (search-like tools), block expansion for 0 results.
        (renderableCount === null || renderableCount > 0) &&
        !NON_EXPANDABLE_TOOLS.has(part.tool_name) &&
        !isExtractionRejected &&
        !isExternalSearchRejected &&
        !showAgentActionView; // Don't allow expand toggle for agent action tools

    const effectiveExpanded = isExpanded && canExpand;

    const handleToggleExpanded = () => {
        if (canExpand) {
            toggleExpanded(expansionKey);
        }
    };

    const getIcon = () => {
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (hasError) return AlertIcon;
        if (effectiveExpanded) return ArrowDownIcon;
        if (isHovered && canExpand) return ArrowRightIcon;
        
        return getToolIcon(part);
    };

    const hasExpandedResult = effectiveExpanded && canExpand;
    const isShimmering = isInProgress && !hasResult && runStatus === 'in_progress';

    // Streaming argument preview for tools that support live preview (e.g., create_note)
    const streamingArgs = part.streaming_args;
    const showStreamingPreview = !!streamingArgs && runStatus === 'in_progress'
        && STREAMING_PREVIEW_TOOLS.has(part.tool_name) && !showAgentActionView && !hasError;

    // Agent-action UI (incl. streaming preview) is host-injected; non-Zotero
    // clients fall back to a request-side summary.
    if (showStreamingPreview && streamingArgs) {
        return getHost().components?.agentActionInStream({
            kind: 'tool-action',
            part,
            runId,
            responseIndex,
            runStatus,
            toolName: part.tool_name,
            pendingApproval: null,
            hasToolReturn: false,
            streamingArgs,
        }) ?? <GenericAgentActionView part={part} runStatus={runStatus} streamingArgs={streamingArgs} />;
    }

    // For agent action tools, show the action UI instead of the normal tool result
    if (showAgentActionView) {
        return getHost().components?.agentActionInStream({
            kind: 'tool-action',
            part,
            runId,
            responseIndex,
            runStatus,
            toolName: actionToolName,
            pendingApproval,
            hasToolReturn: hasResult,
        }) ?? <GenericAgentActionView part={part} runStatus={runStatus} />;
    }

    const effectiveLabelColor = effectiveExpanded
        ? 'font-color-primary'
        : NON_EXPANDABLE_TOOLS.has(part.tool_name)
            ? 'font-color-secondary'
            : '';

    return (
        <div
            id={`tool-${part.tool_call_id}`}
            className={`
                rounded-md flex flex-col min-w-0
                ${effectiveExpanded ? 'border-popup' : 'border-transparent'}
                ${hasExpandedResult ? 'mb-2' : ''}
            `}
        >
            <div
                className={`
                    display-flex flex-row py-15
                    ${effectiveExpanded ? 'border-bottom-quinary bg-senary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <button
                    type="button"
                    className={`variant-ghost-secondary display-flex flex-row py-15 gap-2 w-full text-left ${canExpand ? 'cursor-pointer' : ''}`}
                    style={{ fontSize: '0.95rem', background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={effectiveExpanded}
                    aria-controls={`tool-result-${part.tool_call_id}`}
                    onClick={handleToggleExpanded}
                    disabled={!canExpand}
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className={`flex-1 display-flex mt-010 ${effectiveLabelColor}`}>
                            <Icon icon={getIcon()} />
                        </div>
                        
                        <div className={`display-flex ${effectiveLabelColor} ${isShimmering ? 'shimmer-text' : ''}`}>
                            {label}
                        </div>
                    </div>
                </button>
                <div className="flex-1"/>
            </div>

            {/* Expanded result view */}
            {hasExpandedResult && (
                <div id={`tool-result-${part.tool_call_id}`}>
                    <ToolResultView toolcall={part} result={result} />
                </div>
            )}
        </div>
    );
};

export default ToolCallPartView;
