import React from 'react';
import { AgentAction, PendingApproval } from '../../agents/agentActions';
import {
    CheckmarkCircleIcon,
    CancelCircleIcon,
    AlertIcon,
    Spinner,
} from '../icons/icons';
import { truncateText } from '../../utils/stringUtils';

export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

/**
 * Prompt user to confirm overwriting manually modified fields during undo.
 * Returns true if user confirms, false otherwise.
 */
export function confirmOverwriteManualChanges(modifiedFields: string[]): boolean {
    const fieldList = modifiedFields.join(', ');
    const title = 'Overwrite manual changes?';
    const message = modifiedFields.length === 1
        ? `The field "${fieldList}" has been manually modified since the edit was applied. Do you want to overwrite your changes and revert to the original value?`
        : `The following fields have been manually modified since the edit was applied: ${fieldList}. Do you want to overwrite your changes and revert to the original values?`;

    const buttonIndex = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text: message,
        button0: Zotero.Prompt.BUTTON_TITLE_YES,
        button1: Zotero.Prompt.BUTTON_TITLE_NO,
        defaultButton: 1,
    });

    return buttonIndex === 0;
}

/** Tools that should remain expanded after approval resolves (never auto-collapse) */
export const NEVER_AUTO_COLLAPSE_TOOLS = new Set(['create_note']);

export interface StatusConfig {
    icon: React.FC<React.SVGProps<SVGSVGElement>> | null;
    label: string;
    iconClassName?: string;
    showApply: boolean;
    showReject: boolean;
    showUndo: boolean;
    showRetry: boolean;
}

export const STATUS_CONFIGS: Record<ActionStatus | 'awaiting', StatusConfig> = {
    awaiting: {
        icon: Spinner,
        label: 'Awaiting approval',
        showApply: true,
        showReject: true,
        showUndo: false,
        showRetry: false,
    },
    pending: {
        icon: null,
        label: 'Pending',
        iconClassName: 'font-color-secondary',
        showApply: true,
        showReject: true,
        showUndo: false,
        showRetry: false,
    },
    applied: {
        icon: CheckmarkCircleIcon,
        label: 'Applied',
        iconClassName: 'font-color-green scale-11',
        showApply: false,
        showReject: false,
        showUndo: true,
        showRetry: false,
    },
    rejected: {
        icon: CancelCircleIcon,
        label: 'Rejected',
        iconClassName: 'font-color-red scale-11',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    undone: {
        icon: CancelCircleIcon,
        label: 'Undone',
        iconClassName: 'font-color-red scale-11',
        showApply: true,
        showReject: false,
        showUndo: false,
        showRetry: false,
    },
    error: {
        icon: AlertIcon,
        label: 'Failed',
        iconClassName: 'color-error',
        showApply: false,
        showReject: false,
        showUndo: false,
        showRetry: true,
    },
};

/**
 * Compute the overall status for a group of actions.
 * Used for batch operations where we need a single status to display.
 * Priority: pending > applied (even partial) > error (only if none applied) > rejected/undone
 *
 * Note: We prioritize 'applied' over 'error' when there are mixed results,
 * so users can still undo successfully applied items even if some failed.
 */
export function getOverallStatus(actions: AgentAction[]): ActionStatus {
    if (actions.length === 0) return 'pending';

    const statuses = actions.map(a => a.status);
    const hasApplied = statuses.some(s => s === 'applied');
    const hasPending = statuses.some(s => s === 'pending');
    const hasError = statuses.some(s => s === 'error');

    // If any is pending, show pending (still waiting)
    if (hasPending) return 'pending';
    // If any are applied, show applied (enables Undo for partial success)
    if (hasApplied) return 'applied';
    // If all have errors (none applied), show error
    if (hasError) return 'error';
    // If all are rejected or undone
    if (statuses.every(s => s === 'rejected' || s === 'undone')) return 'rejected';

    return 'pending';
}

/**
 * Get human-readable label for the action
 */
export function getActionLabel(toolName: string): string {
    switch (toolName) {
        case 'edit_metadata':
        case 'edit_item':
            return 'Edit';
        case 'edit_note':
            return 'Note Edit';
        case 'create_note':
            return 'Create Note';
        case 'create_item':
        case 'create_items':
            return 'Import';
        case 'create_collection':
            return 'Create';
        case 'organize_items':
            return 'Organize';
        case 'manage_tags':
            return 'Tag';
        case 'manage_collections':
            return 'Collection';
        case 'confirm_extraction':
            return 'Extract';
        case 'confirm_external_search':
            return 'Search';
        default:
            return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
}

export function getActionTitle(
    toolName: string,
    actionData: Record<string, any> | undefined,
    itemTitle: string | null,
    actions: AgentAction[] | undefined
): string | null {
    switch (toolName) {
        case 'edit_metadata':
        case 'edit_item':
        case 'edit_note':
            return itemTitle ? itemTitle : null;
        case 'create_note':
            return actionData?.title ?? null;
        case 'create_collection':
            return actionData?.name ?? actionData?.proposed_data?.name ?? null;
        case 'organize_items': {
            const itemCount = actionData?.item_ids?.length ?? 0;
            if (itemCount === 0) return null;
            return itemCount === 1 && itemTitle
                ? itemTitle
                : `${itemCount} item${itemCount !== 1 ? 's' : ''}`;
        }
        case 'manage_tags': {
            const name = actionData?.name;
            const op = actionData?.action;
            if (!name) return null;
            if (op === 'delete') return `Delete tag "${name}"`;
            const newName = actionData?.new_name;
            if (newName) {
                return actionData?.is_merge
                    ? `Merge "${name}" → "${newName}"`
                    : `Rename "${name}" → "${newName}"`;
            }
            return `Tag "${name}"`;
        }
        case 'manage_collections': {
            const op = actionData?.action;
            const collectionName = actionData?.collection_name ?? actionData?.old_name ?? actionData?.name;
            if (op === 'delete') {
                return collectionName ? `Delete "${collectionName}"` : 'Delete collection';
            }
            if (op === 'move') {
                return collectionName ? `Move "${collectionName}"` : 'Move collection';
            }
            if (op === 'rename') {
                const newName = actionData?.new_name;
                if (collectionName && newName) return `Rename "${collectionName}" → "${newName}"`;
                if (newName) return `Rename → "${newName}"`;
            }
            return collectionName ?? null;
        }
        case 'confirm_extraction': {
            const count = actionData?.attachment_count ?? 0;
            return `Confirm ${count} Item Batch Processing`;
        }
        case 'confirm_external_search': {
            return 'Confirm External Search';
        }
        case 'create_item':
        case 'create_items': {
            // For create_item, get title from the item data
            // Check actions first, then fall back to actionData (for pending approvals where actions may be empty)
            if (actions && actions.length === 1) {
                const item = actions[0].proposed_data?.item ?? actionData?.item;
                if (item?.title) {
                    return truncateText(item.title, 70);
                }
            } else if ((!actions || actions.length === 0) && actionData?.item?.title) {
                // Pending approval case: actions not yet stored, but we have item data
                return truncateText(actionData.item.title, 60);
            }
            return `${actions && actions.length > 1 ? `${actions.length} ` : ''}Item${actions && actions.length > 1 ? 's' : ''}`;
        }
        default:
            return null;
    }
}

/**
 * Preview data produced from either a pending approval or a stored agent action.
 * Consumed by the ActionPreview dispatcher component.
 */
export interface PreviewData {
    actionType: string;
    actionData: Record<string, any>;
    currentValue?: any;
    resultData?: Record<string, any>;
}

/**
 * Build preview data from either pending approval or agent action
 */
export function buildPreviewData(
    toolName: string,
    pendingApproval: PendingApproval | null,
    action: AgentAction | null
): PreviewData | null {
    if (pendingApproval) {
        return {
            actionType: pendingApproval.actionType,
            actionData: pendingApproval.actionData,
            currentValue: pendingApproval.currentValue,
        };
    }

    if (action) {
        return {
            actionType: action.action_type,
            actionData: action.proposed_data,
            currentValue: undefined, // We don't have this for stored actions
            resultData: action.result_data,
        };
    }

    return null;
}
