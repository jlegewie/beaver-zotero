import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus, ToolCallPart } from '../../agents/types';
import { toolResultsMapAtom, getToolCallStatus } from '../../agents/atoms';
import { getToolCallLabel } from '../../agents/toolLabels';
import { ToolResultView } from './ToolResultView';
import { AgentActionView } from './AgentActionView';
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

    // Reading tools
    search_in_documents: TextAlignLeftIcon,
    search_in_attachment: SearchIcon,
    read_pages: TextAlignLeftIcon,
    view_page_images: ViewIcon,
    view_pages: ViewIcon,

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
};

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
        const args = typeof part.args === 'string' 
            ? JSON.parse(part.args) 
            : (part.args as Record<string, unknown>);
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
    /** Run status */
    runStatus: AgentRunStatus;
}

/**
 * Renders a tool call with its status and result.
 * Uses toolResultsMapAtom to look up the result for this tool call.
 * Visibility state is managed globally via searchToolVisibilityAtom.
 * Shows AgentActionView for tools with agent actions (e.g., edit_metadata).
 */
export const ToolCallPartView: React.FC<ToolCallPartViewProps> = ({ part, runId, runStatus }) => {
    const resultsMap = useAtomValue(toolResultsMapAtom);
    const result = resultsMap.get(part.tool_call_id);
    const hasResult = result !== undefined;
    const status = getToolCallStatus(part.tool_call_id, resultsMap, runStatus);
    const baseLabel = getToolCallLabel(part, status);
    
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
        part.tool_name === 'organize_items' ||
        part.tool_name === 'create_items';
    const isExtractConfirmApproval =
        part.tool_name === 'extract' &&
        pendingApproval?.actionType === 'confirm_extraction';
    const isExtractionRejected =
        part.tool_name === 'extract' &&
        hasResult &&
        result?.content?.status &&
        result?.content?.status === 'REJECTED';

    // For extract, only render AgentActionView while approval is pending.
    // After approval, fall back to normal tool-call rendering so the in-progress spinner stays visible.
    const showAgentActionView =
        (isStandardAgentActionTool && (isAwaitingApproval || hasAgentAction)) ||
        isExtractConfirmApproval;
    const actionToolName = isExtractConfirmApproval ? 'confirm_extraction' : part.tool_name;

    const resultCount =
        result && result.part_kind === 'tool-return'
            ? result?.metadata?.summary?.result_count ?? null
            : null;

    const label =
        status === 'completed' && resultCount !== null
            ? `${baseLabel} (${resultCount} result${resultCount === 1 ? '' : 's'})`
            : baseLabel;

    // Use global Jotai atom for expansion state (persists across re-renders and syncs between panes)
    const expansionKey = `${runId}:${part.tool_call_id}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const toggleExpanded = useSetAtom(toggleToolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const isExpanded = expansionState[expansionKey] ?? false;
    const wasExtractConfirmApprovalRef = useRef(isExtractConfirmApproval);

    // When extract approval resolves, collapse once so the completed result doesn't auto-expand.
    // Users can still expand manually afterward.
    useEffect(() => {
        const wasExtractConfirmApproval = wasExtractConfirmApprovalRef.current;
        if (part.tool_name === 'extract' && wasExtractConfirmApproval && !isExtractConfirmApproval) {
            setExpanded({ key: expansionKey, expanded: false });
        }
        wasExtractConfirmApprovalRef.current = isExtractConfirmApproval;
    }, [part.tool_name, isExtractConfirmApproval, expansionKey, setExpanded]);

    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    const hasError = status === 'error';

    const canExpand =
        hasResult &&
        result?.part_kind === 'tool-return' &&
        // If we can compute a count (search-like tools), block expansion for 0 results.
        (resultCount === null || resultCount > 0) &&
        part.tool_name !== 'read_file' &&
        !isExtractionRejected && 
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

    // For agent action tools, show the AgentActionView instead of normal tool result
    if (showAgentActionView) {
        return (
            <AgentActionView
                toolcallId={part.tool_call_id}
                toolName={actionToolName}
                runId={runId}
                pendingApproval={pendingApproval}
            />
        );
    }

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
                        <div className={`flex-1 display-flex mt-010 ${effectiveExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={getIcon()} />
                        </div>
                        
                        <div className={`display-flex ${effectiveExpanded ? 'font-color-primary' : ''} ${isShimmering ? 'shimmer-text' : ''}`}>
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
