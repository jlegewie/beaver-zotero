import React from 'react';
import type { AgentAction } from '../../agents/agentActions';
import type { OrganizeItemsResultData } from '../../types/agentActions/base';
import { EditMetadataPreview } from './EditMetadataPreview';
import { CreateCollectionPreview } from './CreateCollectionPreview';
import { OrganizeItemsPreview } from './OrganizeItemsPreview';
import { CreateItemsPreview } from './CreateItemsPreview';
import { ConfirmExtractionPreview } from './ConfirmExtractionPreview';
import { ConfirmExternalSearchPreview } from './ConfirmExternalSearchPreview';
import { EditNotePreview } from './EditNotePreview';
import { CreateNotePreview } from './CreateNotePreview';
import { ManageTagsPreview } from './ManageTagsPreview';
import { ManageCollectionsPreview } from './ManageCollectionsPreview';
import type { ActionStatus, PreviewData } from './agentActionViewHelpers';

/**
 * Dispatches to action-specific preview components
 */
export const ActionPreview: React.FC<{
    toolName: string;
    previewData: PreviewData;
    status: ActionStatus | 'awaiting';
    /** All actions for the tool call (for multi-item create_items) */
    actions?: AgentAction[];
    /** Whether tool call arguments are actively streaming */
    isStreaming?: boolean;
}> = ({ toolName, previewData, status, actions, isStreaming }) => {
    if (toolName === 'edit_metadata' || previewData.actionType === 'edit_metadata') {
        const edits = previewData.actionData.edits || [];

        // Get current values from previewData.currentValue (pending approval)
        // or extract from edits[].old_value (stored actions)
        let currentValues = previewData.currentValue || {};
        if (Object.keys(currentValues).length === 0 && edits.length > 0) {
            currentValues = {};
            for (const edit of edits) {
                if (edit.old_value !== undefined) {
                    currentValues[edit.field] = edit.old_value;
                }
            }
        }

        // For applied actions, show the applied values if available
        const appliedEdits = previewData.resultData?.applied_edits;

        // Creator data: old from resultData, proposed_data, or currentValue
        const oldCreators = previewData.resultData?.old_creators
            ?? previewData.actionData.old_creators
            ?? previewData.currentValue?.current_creators
            ?? null;
        const newCreators = previewData.resultData?.new_creators
            ?? previewData.actionData.creators
            ?? null;

        return (
            <EditMetadataPreview
                edits={edits}
                currentValues={currentValues}
                appliedEdits={appliedEdits}
                status={status}
                oldCreators={oldCreators}
                newCreators={newCreators}
            />
        );
    }

    if (toolName === 'create_collection' || previewData.actionType === 'create_collection') {
        const name = previewData.actionData.name || '';
        const parentKey = previewData.actionData.parent_key;
        const itemIds = previewData.actionData.item_ids || [];

        // Get library name and item count from current_value
        const libraryName = previewData.currentValue?.library_name;
        const itemCount = previewData.currentValue?.item_count ?? itemIds.length;

        return (
            <CreateCollectionPreview
                name={name}
                libraryName={libraryName}
                parentKey={parentKey}
                itemCount={itemCount}
                status={status}
                resultData={previewData.resultData}
            />
        );
    }

    if (toolName === 'organize_items' || previewData.actionType === 'organize_items') {
        const itemIds = previewData.actionData.item_ids || [];
        const tags = previewData.actionData.tags;
        const collections = previewData.actionData.collections;

        return (
            <OrganizeItemsPreview
                itemIds={itemIds}
                tags={tags}
                collections={collections}
                status={status}
                resultData={previewData.resultData as OrganizeItemsResultData | undefined}
            />
        );
    }

    if (toolName === 'manage_tags' || previewData.actionType === 'manage_tags') {
        return (
            <ManageTagsPreview
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                status={status}
                resultData={previewData.resultData as any}
                errorMessage={previewData.errorMessage}
            />
        );
    }

    if (toolName === 'manage_collections' || previewData.actionType === 'manage_collections') {
        return (
            <ManageCollectionsPreview
                actionData={previewData.actionData}
                currentValue={previewData.currentValue}
                status={status}
                resultData={previewData.resultData as any}
                errorMessage={previewData.errorMessage}
            />
        );
    }

    if (toolName === 'confirm_extraction' || previewData.actionType === 'confirm_extraction') {
        return (
            <ConfirmExtractionPreview
                attachmentCount={previewData.actionData.attachment_count ?? 0}
                extraCredits={previewData.actionData.extra_credits ?? 0}
                totalCredits={previewData.actionData.total_credits ?? 0}
                includedFree={previewData.actionData.included_free ?? 0}
                label={previewData.actionData.label}
                status={status}
            />
        );
    }

    if (toolName === 'confirm_external_search' || previewData.actionType === 'confirm_external_search') {
        return (
            <ConfirmExternalSearchPreview
                extraCredits={previewData.actionData.extra_credits ?? 0}
                totalCredits={previewData.actionData.total_credits ?? 0}
                label={previewData.actionData.label}
                status={status}
            />
        );
    }

    if (toolName === 'create_items' || toolName === 'create_item' || previewData.actionType === 'create_item') {
        // If no actions array provided, return fallback
        if (!actions || actions.length === 0) {
            return (
                <div className="text-sm font-color-secondary px-3 py-2">
                    No item data available
                </div>
            );
        }

        return (
            <CreateItemsPreview
                actions={actions}
                status={status}
            />
        );
    }

    if (toolName === 'edit_note' || previewData.actionType === 'edit_note') {
        const op = (previewData.actionData.operation ?? 'str_replace') as import('../../types/agentActions/editNote').EditNoteOperation;
        const isRewrite = op === 'rewrite';
        const oldString = isRewrite ? '' : (previewData.actionData.old_string || '');
        const newString = previewData.actionData.new_string || '';
        const occurrencesReplaced = previewData.resultData?.occurrences_replaced;
        const warnings = previewData.resultData?.warnings;
        // For rewrite, get old content from validation's current_value
        // or from undo_full_html in result_data (post-apply)
        const oldContent = isRewrite
            ? (previewData.currentValue?.old_content || previewData.resultData?.undo_full_html)
            : undefined;

        return (
            <EditNotePreview
                oldString={oldString}
                newString={newString}
                operation={op}
                oldContent={oldContent}
                occurrencesReplaced={occurrencesReplaced}
                warnings={warnings}
                status={status}
                libraryId={previewData.actionData.library_id}
                zoteroKey={previewData.actionData.zotero_key}
            />
        );
    }

    if (toolName === 'create_note' || previewData.actionType === 'create_note') {
        const noteContent = previewData.actionData.content || '';

        return (
            <CreateNotePreview
                content={noteContent}
                resultData={previewData.resultData}
                status={status}
                isStreaming={isStreaming}
            />
        );
    }

    // Fallback for unsupported action types
    return (
        <div className="text-sm font-color-secondary">
            <div className="font-medium mb-1">Action: {previewData.actionType}</div>
            <pre className="text-xs overflow-auto max-h-32 p-2 rounded">
                {JSON.stringify(previewData.actionData, null, 2)}
            </pre>
        </div>
    );
};
