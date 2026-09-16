import React from 'react';
import { ToolReturnPart } from '@beaver/agent-core/agents/types';
import { isToolResultView, ToolResultView as ToolResultViewModel } from '@beaver/agent-core/run-state/toolResultViews';
import { getHost } from '@beaver/agent-ui/host';
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

interface ToolResultViewProps {
    result: ToolReturnPart;
}

/**
 * Map a hydrated view model to its shared presentational component.
 *
 * Returns null for unsupported view types so the generic fallback can handle the
 * result.
 */
function renderFromView(view: ToolResultViewModel): React.ReactNode | null {
    switch (view.view_type) {
        case 'table':
            return <TableResultView view={view} />;
        case 'item_list':
            return <ItemListResultView view={view} />;
        case 'external_reference_list':
            return <ExternalReferenceListResultView view={view} />;
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

/**
 * Renders a tool result from its hydrated, client-agnostic view model.
 *
 * Every successful tool return carries a `metadata.view` — shipped by the backend,
 * or synthesized from the legacy summary by `upgradeToolReturn`
 * (`react/compat/legacyToolResults.ts`) on thread load and live returns. When no
 * valid view can be produced, the generic fallback renders instead.
 *
 * Note: Annotation tools are handled separately by AnnotationToolCallView
 * and don't go through this dispatcher.
 */
export const ToolResultView: React.FC<ToolResultViewProps> = ({ result }) => {
    const view = result.metadata?.view;
    const isTable = isTableToolName(result.tool_name);
    const body = { ...tableResultBody(result.content) };
    if (isToolResultView(view) && view.view_type === 'table') {
        // The card retains repair status even after its body is dehydrated.
        delete body.repair_warning;
        delete body.saved;
    }
    const messages = isTable ? tableResultMessages(body) : [];
    const notices = messages.map((message, index) => <div key={index} role="status" className="p-2 text-sm">{message}</div>);
    if (isToolResultView(view)) {
        const fromView = renderFromView(view);
        if (fromView) return <>{fromView}{notices}</>;
    }
    if (messages.length) return <>{notices}</>;
    return <GenericResultView content={result.content} />;
};

/**
 * Generic fallback renderer for tool results without a renderable view model.
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
            {getHost().config?.isDevelopment() ? (
                <pre className="whitespace-pre-wrap font-mono text-xs opacity-80">
                    {formatContent()}
                </pre>
            ) : (
                <div className="font-color-secondary">
                    Tool results not available
                </div>
            )}
        </div>
    );
};

export default ToolResultView;
