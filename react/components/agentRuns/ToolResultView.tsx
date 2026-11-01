import { DuplicatesResultView } from './toolResultViews/DuplicatesResultView';
import React from 'react';
import { ToolReturnPart } from '@beaver/agent-core/agents/types';
import { isToolResultView, ToolResultView as ToolResultViewModel } from '@beaver/agent-core/run-state/toolResultViews';
import { ItemListResultView } from './toolResultViews/ItemListResultView';
import { ExternalReferenceListResultView } from './toolResultViews/ExternalReferenceListResultView';
import { CollectionListResultView } from './toolResultViews/CollectionListResultView';
import { TagListResultView } from './toolResultViews/TagListResultView';
import { AnnotationListResultView } from './toolResultViews/AnnotationListResultView';
import { AttachmentSearchResultView } from './toolResultViews/AttachmentSearchResultView';
import { UserQuestionResultView } from './toolResultViews/UserQuestionResultView';
import { BatchJobResultView } from './toolResultViews/BatchJobResultView';
import { TableResultView } from './toolResultViews/TableResultView';
import { tableResultMessages } from '@beaver/agent-core/run-state/toolResultViews';
import { isTableToolName, tableResultBody } from '@beaver/agent-core/run-state/tableResults';

/** The search-details panel a source search shows at the top of its results, opened from the card header. */
export interface SearchDetailsDisclosure {
    open: boolean;
    /** Element id of the panel, for the header button's aria-controls. */
    id: string;
}

interface ToolResultViewProps {
    result: ToolReturnPart;
    searchDetails?: SearchDetailsDisclosure;
}

/**
 * Map a hydrated view model to its shared presentational component.
 *
 * Returns null for view types this client does not render.
 */
function renderFromView(view: ToolResultViewModel, searchDetails?: SearchDetailsDisclosure): React.ReactNode | null {
    switch (view.view_type) {
        case 'duplicates': return <DuplicatesResultView view={view} />;
        case 'table':
            return <TableResultView view={view} />;
        case 'item_list':
            return <ItemListResultView view={view} />;
        case 'external_reference_list':
            return <ExternalReferenceListResultView view={view} searchDetails={searchDetails} />;
        case 'collection_list':
            return <CollectionListResultView view={view} />;
        case 'tag_list':
            return <TagListResultView view={view} />;
        case 'annotation_list':
            return <AnnotationListResultView view={view} />;
        case 'attachment_search':
            return <AttachmentSearchResultView view={view} />;
        case 'user_question':
            return <UserQuestionResultView view={view} />;
        case 'batch_operation':
            return <BatchJobResultView view={view} />;
        default:
            return null;
    }
}

/** Table status messages shown with (or instead of) a table tool's result. */
export function tableMessages(result: ToolReturnPart): string[] {
    if (!isTableToolName(result.tool_name)) return [];
    return tableResultMessages(tableResultBody(result.content), result.tool_name);
}

/**
 * Whether ToolResultView has anything to render for this return. Callers gate
 * expansion on it, so tools without a client-side view (e.g. tools added to the
 * backend after this client shipped) stay collapsed instead of exposing the raw
 * return written for the model.
 */
export function hasRenderableResult(result: ToolReturnPart): boolean {
    const view = result.metadata?.view;
    if (isToolResultView(view) && renderFromView(view) !== null) return true;
    return tableMessages(result).length > 0;
}

/**
 * Renders a tool result from its hydrated, client-agnostic view model.
 *
 * Successful tool returns carry a `metadata.view` — shipped by the backend, or
 * synthesized from the legacy summary by `upgradeToolReturn`
 * (`react/compat/legacyToolResults.ts`) on thread load and live returns. Renders
 * nothing when there is no view this client supports (see hasRenderableResult).
 *
 * Note: Annotation tools are handled separately by AnnotationToolCallView
 * and don't go through this dispatcher.
 */
export const ToolResultView: React.FC<ToolResultViewProps> = ({ result, searchDetails }) => {
    const view = result.metadata?.view;
    const notices = tableMessages(result).map((message, index) => (
        <div key={index} role="status" className="px-3 py-2 text-sm font-color-secondary">{message}</div>
    ));
    const fromView = isToolResultView(view) ? renderFromView(view, searchDetails) : null;
    if (!fromView && notices.length === 0) return null;
    return <>{fromView}{notices}</>;
};

export default ToolResultView;
