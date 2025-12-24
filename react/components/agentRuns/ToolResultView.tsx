import React from 'react';
import { ToolCallPart, ToolReturnPart } from '../../agents/types';
import { 
    isItemSearchResult,
    extractItemSearchData,
    isFulltextSearchResult,
    extractFulltextSearchData,
    isReadPagesResult,
    extractReadPagesData,
    isViewPageImagesResult,
    extractViewPageImagesData,
    isSearchInDocumentsResult,
    extractSearchInDocumentsData,
    isExternalSearchResult,
    extractExternalSearchData,
} from '../../agents/toolResultTypes';
import { ItemSearchResultView } from './ItemSearchResultView';
import { FulltextSearchResultView } from './FulltextSearchResultView';
import { ReadPagesResultView } from './ReadPagesResultView';
import { ViewPageImagesResultView } from './ViewPageImagesResultView';
import { ExternalSearchResultView } from './ExternalSearchResultView';

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

    // Read pages results (read_pages)
    if (isReadPagesResult(toolName, content, metadata)) {
        const data = extractReadPagesData(content, metadata);
        if (data) {
            return <ReadPagesResultView attachment={data.attachment} />;
        }
    }

    // View page images results (view_page_images)
    if (isViewPageImagesResult(toolName, content, metadata)) {
        const data = extractViewPageImagesData(content, metadata);
        if (data) {
            return <ViewPageImagesResultView pages={data.pages} />;
        }
    }

    // Search in documents results (search_in_documents)
    if (isSearchInDocumentsResult(toolName, content, metadata)) {
        const data = extractSearchInDocumentsData(content, metadata);
        if (data) {
            return <FulltextSearchResultView chunks={data.chunks} />;
        }
    }

    // External search results (external_search, search_external_references)
    if (isExternalSearchResult(toolName, content, metadata)) {
        const data = extractExternalSearchData(content, metadata);
        if (data) {
            return <ExternalSearchResultView references={data.references} />;
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
