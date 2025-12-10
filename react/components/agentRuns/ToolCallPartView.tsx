import React, { useState } from 'react';
import { useAtomValue } from 'jotai';
import { ToolCallPart } from '../../agents/types';
import { toolResultsMapAtom, getToolCallStatus } from '../../agents/atoms';
import { getToolCallLabel } from '../../agents/toolLabels';
import { ToolResultView } from './ToolResultView';
import Button from '../ui/Button';
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
    HighlighterIcon,
    PlusSignIcon,
    TextAlignLeftIcon,
} from '../icons/icons';

type IconComponent = React.FC<React.SVGProps<SVGSVGElement>>;

/**
 * Maps tool names to their appropriate icons
 */
const TOOL_ICONS: Record<string, IconComponent> = {
    // Search tools - library search
    search_by_metadata: SearchIcon,
    search_by_topic: SearchIcon,
    search_library_fulltext: SearchIcon,
    search_library_fulltext_keywords: SearchIcon,
    search_references_by_topic: SearchIcon,
    search_references_by_metadata: SearchIcon,
    search_fulltext: SearchIcon,
    search_fulltext_keywords: SearchIcon,
    search_attachments_content: SearchIcon,
    search_attachments_content_keyword: SearchIcon,
    rag_search: SearchIcon,

    // Reading tools
    retrieve_fulltext: TextAlignLeftIcon,
    retrieve_passages: TextAlignLeftIcon,
    read_passages: TextAlignLeftIcon,
    read_fulltext: TextAlignLeftIcon,
    view_page_images: ViewIcon,

    // Annotation tools
    add_highlight_annotations: HighlighterIcon,
    add_note_annotations: HighlighterIcon,

    // External search tools
    search_external_references: GlobalSearchIcon,
    external_search: GlobalSearchIcon,

    // Create item tool
    create_zotero_item: PlusSignIcon,
};

/**
 * Get the icon for a tool based on its name
 */
function getToolIcon(toolName: string): IconComponent {
    return TOOL_ICONS[toolName] ?? PuzzleIcon;
}

interface ToolCallPartViewProps {
    part: ToolCallPart;
}

/**
 * Renders a tool call with its status and result.
 * Uses toolResultsMapAtom to look up the result for this tool call.
 */
export const ToolCallPartView: React.FC<ToolCallPartViewProps> = ({ part }) => {
    const resultsMap = useAtomValue(toolResultsMapAtom);
    const result = resultsMap.get(part.tool_call_id);
    const status = getToolCallStatus(part.tool_call_id, resultsMap);
    const label = getToolCallLabel(part);

    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);

    const isInProgress = status === 'in_progress';
    const hasError = status === 'error';
    const hasResult = result !== undefined;

    const toggleExpanded = () => {
        if (hasResult) {
            setIsExpanded(!isExpanded);
        }
    };

    const getIcon = () => {
        if (isInProgress) return Spinner;
        if (hasError) return AlertIcon;
        if (isExpanded) return ArrowDownIcon;
        if (isHovered && hasResult) return ArrowRightIcon;
        
        return getToolIcon(part.tool_name);
    };

    const isButtonDisabled = isInProgress || (hasError && !hasResult);

    return (
        <div
            id={`tool-${part.tool_call_id}`}
            className={`
                rounded-md flex flex-col min-w-0
                ${isExpanded ? 'border-popup' : 'border-transparent'}
            `}
        >
            <div
                className={`
                    display-flex flex-row py-15
                    ${isExpanded ? 'border-bottom-quinary bg-senary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <Button
                    variant="ghost-secondary"
                    onClick={toggleExpanded}
                    className={`
                        text-base scale-105 w-full min-w-0 align-start text-left
                        ${isButtonDisabled && !hasResult ? 'disabled-but-styled' : ''}
                    `}
                    style={{ padding: '2px 6px', maxHeight: 'none' }}
                    disabled={!result || (isButtonDisabled && !hasResult) || result.part_kind === 'retry-prompt'}
                >
                    <div className="display-flex flex-row px-3 gap-2">
                        <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                            <Icon icon={getIcon()} />
                        </div>
                        
                        <div className={`display-flex ${isExpanded ? 'font-color-primary' : ''} ${isInProgress ? 'shimmer-text' : ''}`}>
                            {label}
                        </div>
                    </div>
                </Button>
            </div>

            {/* Expanded result view */}
            {isExpanded && hasResult && result.part_kind === 'tool-return' && (
                <ToolResultView result={result} />
            )}
        </div>
    );
};

export default ToolCallPartView;

