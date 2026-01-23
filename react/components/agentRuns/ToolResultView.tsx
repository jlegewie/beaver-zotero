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
    isSearchInAttachmentResult,
    extractSearchInAttachmentData,
    isExternalSearchResult,
    extractExternalSearchData,
    isLookupWorkResult,
    extractLookupWorkData,
    isReadPagesFrontendResult,
    extractReadPagesFrontendData,
    isZoteroSearchResult,
    extractZoteroSearchData,
    isListItemsResult,
    extractListItemsData,
    isListCollectionsResult,
    extractListCollectionsData,
    isListTagsResult,
    extractListTagsData,
    isGetMetadataResult,
    extractGetMetadataData,
} from '../../agents/toolResultTypes';
import { ItemSearchResultView } from './ItemSearchResultView';
import { FulltextSearchResultView } from './FulltextSearchResultView';
import { ReadPagesResultView } from './ReadPagesResultView';
import { ViewPageImagesResultView } from './ViewPageImagesResultView';
import { ExternalSearchResultView } from './ExternalSearchResultView';
import { ListCollectionsResultView } from './ListCollectionsResultView';
import { ListTagsResultView } from './ListTagsResultView';

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
    if (isReadPagesResult(toolName, content, metadata) || isReadPagesFrontendResult(toolName, content, metadata)) {
        const data = isReadPagesResult(toolName, content, metadata)
            ? extractReadPagesData(content, metadata)
            : extractReadPagesFrontendData(content, metadata);
        if (data) {
            return <ReadPagesResultView pages={data.pages} />;
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

    // Search in attachment results (search_in_attachment - keyword search)
    if (isSearchInAttachmentResult(toolName, content, metadata)) {
        const data = extractSearchInAttachmentData(content, metadata);
        if (data) {
            return <ReadPagesResultView pages={data.pages} />;
        }
    }

    // External search results (external_search, search_external_references)
    if (isExternalSearchResult(toolName, content, metadata)) {
        const data = extractExternalSearchData(content, metadata);
        if (data) {
            return <ExternalSearchResultView references={data.references} />;
        }
    }

    // Lookup work results (lookup_work)
    if (isLookupWorkResult(toolName, content, metadata)) {
        const data = extractLookupWorkData(content, metadata);
        if (data) {
            if (data.found && data.reference) {
                return <ExternalSearchResultView references={[data.reference]} />;
            }
            // Not found case - show message
            return (
                <div className="tool-result-view p-3 text-sm">
                    <div className="font-color-secondary">
                        {data.message || 'Work not found'}
                    </div>
                </div>
            );
        }
    }

    // Zotero search results (zotero_search)
    if (isZoteroSearchResult(toolName, content, metadata)) {
        const data = extractZoteroSearchData(content, metadata);
        if (data) {
            return <ItemSearchResultView items={data.items} />;
        }
    }

    // List items results (list_items)
    if (isListItemsResult(toolName, content, metadata)) {
        const data = extractListItemsData(content, metadata);
        if (data) {
            return <ItemSearchResultView items={data.items} />;
        }
    }

    // List collections results (list_collections)
    if (isListCollectionsResult(toolName, content, metadata)) {
        const data = extractListCollectionsData(content, metadata);
        if (data) {
            return (
                <ListCollectionsResultView
                    collections={data.collections}
                    totalCount={data.totalCount}
                    libraryId={data.libraryId}
                />
            );
        }
    }

    // List tags results (list_tags)
    if (isListTagsResult(toolName, content, metadata)) {
        const data = extractListTagsData(content, metadata);
        if (data) {
            return (
                <ListTagsResultView
                    tags={data.tags}
                    totalCount={data.totalCount}
                    libraryId={data.libraryId}
                />
            );
        }
    }

    // Get metadata results (get_metadata)
    if (isGetMetadataResult(toolName, content, metadata)) {
        const data = extractGetMetadataData(content, metadata);
        if (data && data.items.length > 0) {
            return <ItemSearchResultView items={data.items} />;
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

    return (
        <div className="tool-result-view p-3 text-sm overflow-x-auto">
            {Zotero.Beaver.data.env === "development" ? (
                <pre className="whitespace-pre-wrap font-mono text-xs opacity-80">
                    {formatContent()}
                </pre>
            ) : (
                <div className="font-color-secondary">
                    No result to display
                </div>
            )}
            
        </div>
    );
};

export default ToolResultView;
