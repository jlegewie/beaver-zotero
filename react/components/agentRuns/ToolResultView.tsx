import React from 'react';
import { ToolCallPart, ToolReturnPart } from '../../agents/types';
import { 
    isItemSearchResult,
    extractItemSearchData,
    isFulltextSearchResult, 
    isFulltextRetrievalResult,
    isSearchExternalReferencesResult
} from '../../agents/toolResultTypes';
import { ItemSearchResultView } from './ItemSearchResultView';
import { FulltextSearchResultView } from './FulltextSearchResultView';
import { FulltextRetrievalResultView } from './FulltextRetrievalResultView';
import { ExternalReferencesSearchResultView } from './ExternalReferencesSearchResultView';

interface ToolResultViewProps {
    toolcall: ToolCallPart;
    result: ToolReturnPart;
}

/**
 * Renders the result of a tool call.
 * Dispatches to specialized renderers based on the result type,
 * with a fallback to generic JSON/markdown rendering.
 */
export const ToolResultView: React.FC<ToolResultViewProps> = ({ toolcall, result }) => {
    const toolName = toolcall.tool_name;
    const content = result.content;
    const metadata = result.metadata;

    // Item search results (search_references_by_topic, search_references_by_metadata)
    if (isItemSearchResult(toolName, content, metadata)) {
        const data = extractItemSearchData(content, metadata);
        if (data) {
            return <ItemSearchResultView data={data} />;
        }
    }

    if (isFulltextSearchResult(content)) {
        return <FulltextSearchResultView result={content} />;
    }

    if (isFulltextRetrievalResult(content)) {
        return <FulltextRetrievalResultView result={content} />;
    }

    if (isSearchExternalReferencesResult(content)) {
        return <ExternalReferencesSearchResultView result={content} />;
    }

    // Fallback: generic rendering for other result types
    return <GenericResultView content={content} />;
};

/**
 * Generic fallback renderer for tool results that don't have a specialized view.
 */
const GenericResultView: React.FC<{ content: unknown }> = ({ content }) => {
    const formatContent = () => {
        if (typeof content === 'string') {
            return content;
        }
        if (content === null || content === undefined) {
            return 'No result';
        }
        try {
            return JSON.stringify(content, null, 2);
        } catch {
            return String(content);
        }
    };

    const formattedContent = formatContent();

    return (
        <div className="tool-result-view p-3 text-sm overflow-x-auto">
            <pre className="whitespace-pre-wrap font-mono text-xs opacity-80">
                {formattedContent}
            </pre>
        </div>
    );
};

export default ToolResultView;
