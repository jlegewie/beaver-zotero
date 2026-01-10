import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { AgentRunStatus, ToolCallPart } from '../../agents/types';
import { toolResultsMapAtom, getToolCallStatus } from '../../agents/atoms';
import { getToolCallLabel } from '../../agents/toolLabels';
import { ToolResultView } from './ToolResultView';
import {
    Spinner,
    AlertIcon,
    ArrowDownIcon,
    ArrowRightIcon,
    SearchIcon,
    ViewIcon,
    Icon,
    PuzzleIcon,
    GlobalSearchIcon,
    TextAlignLeftIcon,
    DocumentValidationIcon,
} from '../icons/icons';
import { searchToolVisibilityAtom, toggleSearchToolVisibilityAtom } from '../../atoms/messageUIState';

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

    // Reading tools
    search_in_documents: TextAlignLeftIcon,
    search_in_attachment: SearchIcon,
    read_pages: TextAlignLeftIcon,
    view_page_images: ViewIcon,
    view_pages: ViewIcon,

    // External search tools
    external_search: GlobalSearchIcon,

    // Create item tool
    create_zotero_item: DocumentValidationIcon,

    // Read tool result
    read_file: TextAlignLeftIcon,
};

/**
 * Get the icon for a tool based on its name
 */
function getToolIcon(toolName: string): IconComponent {
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
 */
export const ToolCallPartView: React.FC<ToolCallPartViewProps> = ({ part, runId, runStatus }) => {
    const resultsMap = useAtomValue(toolResultsMapAtom);
    const result = resultsMap.get(part.tool_call_id);
    const status = getToolCallStatus(part.tool_call_id, resultsMap);
    const baseLabel = getToolCallLabel(part, status);

    const resultCount =
        result && result.part_kind === 'tool-return'
            ? result?.metadata?.summary?.result_count ?? null
            : null;

    const label =
        status === 'completed' && resultCount !== null
            ? `${baseLabel} (${resultCount} result${resultCount === 1 ? '' : 's'})`
            : baseLabel;

    // Use global Jotai atom for visibility state (persists across re-renders and syncs between panes)
    const visibilityKey = `${runId}:${part.tool_call_id}`;
    const searchVisibility = useAtomValue(searchToolVisibilityAtom);
    const toggleVisibility = useSetAtom(toggleSearchToolVisibilityAtom);
    const isExpanded = searchVisibility[visibilityKey] ?? false;

    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    const hasError = status === 'error';
    const hasResult = result !== undefined;

    const canExpand =
        hasResult &&
        result?.part_kind === 'tool-return' &&
        // If we can compute a count (search-like tools), block expansion for 0 results.
        (resultCount === null || resultCount > 0) &&
        part.tool_name !== 'read_file';

    const effectiveExpanded = isExpanded && canExpand;

    const toggleExpanded = () => {
        if (canExpand) {
            toggleVisibility(visibilityKey);
        }
    };

    const getIcon = () => {
        if (isInProgress && (runStatus === 'canceled' || runStatus === 'error')) return AlertIcon;
        if (isInProgress) return Spinner;
        if (hasError) return AlertIcon;
        if (effectiveExpanded) return ArrowDownIcon;
        if (isHovered && canExpand) return ArrowRightIcon;
        
        return getToolIcon(part.tool_name);
    };

    const hasExpandedResult = effectiveExpanded && canExpand;
    const isShimmering = isInProgress && !hasResult && runStatus === 'in_progress';

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
                    onClick={toggleExpanded}
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

