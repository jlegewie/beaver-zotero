import React from 'react';
import { ToolCallPart, ToolReturnPart } from '../../agents/types';
import { 
    isItemSearchResult,
    extractItemSearchData,
    isFulltextSearchResult,
    extractFulltextSearchData,
    isFulltextRetrievalResult,
    extractFulltextRetrievalData,
    isPassageRetrievalResult,
    extractPassageRetrievalData,
    isExternalSearchResult,
    extractExternalSearchData,
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
 * 
 * Note: Annotation tools are handled separately by AnnotationToolCallView
 * and don't go through this dispatcher.
 */
export const ToolResultView: React.FC<ToolResultViewProps> = ({ toolcall, result }) => {
    const toolName = toolcall.tool_name;
    const content = result.content;
    const metadata = result.metadata;

    // Item search results (search_references_by_topic, search_references_by_metadata)
    if (isItemSearchResult(toolName, content, metadata)) {
        const data = extractItemSearchData(content, metadata);
        if (data) {
            return <ItemSearchResultView items={data.items} />;
        }
    }

    // Fulltext search results (search_fulltext, search_fulltext_keywords, etc.)
    if (isFulltextSearchResult(toolName, content, metadata)) {
        const data = extractFulltextSearchData(content, metadata);
        if (data) {
            return <FulltextSearchResultView chunks={data.chunks} />;
        }
    }

    // Fulltext retrieval results (read_fulltext, retrieve_fulltext)
    if (isFulltextRetrievalResult(toolName, content, metadata)) {
        const data = extractFulltextRetrievalData(content, metadata);
        if (data) {
            return <FulltextRetrievalResultView attachment={data.attachment} />;
        }
    }

    // Passage retrieval results (read_passages, retrieve_passages)
    if (isPassageRetrievalResult(toolName, content, metadata)) {
        const data = extractPassageRetrievalData(content, metadata);
        if (data) {
            return <FulltextSearchResultView chunks={data.chunks} />;
        }
    }

    // External search results (external_search, search_external_references)
    if (isExternalSearchResult(toolName, content, metadata)) {
        const data = extractExternalSearchData(content, metadata);
        if (data) {
            return <ExternalReferencesSearchResultView references={data.references} />;
        }
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
