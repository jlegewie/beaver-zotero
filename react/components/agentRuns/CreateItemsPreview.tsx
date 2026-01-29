import React from 'react';
import ReferenceMetadataDisplay from '../externalReferences/ReferenceMetadataDisplay';
import { AgentAction } from '../../agents/agentActions';
import { CreateItemProposedData, CreateItemResultData } from '../../types/agentActions/items';
import { CheckmarkCircleIcon, CancelCircleIcon, AlertIcon, Icon } from '../icons/icons';
import { revealSource } from '../../utils/sourceUtils';
import IconButton from '../ui/IconButton';
import { ArrowUpRightIcon } from '../icons/icons';
import Tooltip from '../ui/Tooltip';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateItemsPreviewProps {
    /** Array of create_item agent actions */
    actions: AgentAction[];
    /** Current status of the actions (batch status) */
    status?: ActionStatus;
    /** Whether to show status icons for individual items (defaults to true for multiple items, false for single item) */
    showStatusIcons?: boolean;
}

/**
 * Get the overall status for a group of actions.
 * Priority: error > pending/awaiting > applied > rejected/undone
 */
function getOverallStatus(actions: AgentAction[]): ActionStatus {
    const statuses = actions.map(a => a.status);
    
    // If any has error, show error
    if (statuses.some(s => s === 'error')) return 'error';
    // If any is pending, show pending
    if (statuses.some(s => s === 'pending')) return 'pending';
    // If all are applied, show applied
    if (statuses.every(s => s === 'applied')) return 'applied';
    // If any is rejected or undone
    if (statuses.some(s => s === 'rejected' || s === 'undone')) {
        // If all are rejected/undone, show rejected
        if (statuses.every(s => s === 'rejected' || s === 'undone')) return 'rejected';
    }
    
    return 'pending';
}

/**
 * Get status icon and styling for a single action
 */
function getStatusIndicator(status: ActionStatus): { icon: React.FC<React.SVGProps<SVGSVGElement>> | null; className: string } {
    switch (status) {
        case 'applied':
            return { icon: CheckmarkCircleIcon, className: 'font-color-green scale-11' };
        case 'rejected':
        case 'undone':
            return { icon: CancelCircleIcon, className: 'font-color-red scale-11' };
        case 'error':
            return { icon: AlertIcon, className: 'color-error' };
        default:
            return { icon: null, className: '' };
    }
}

/**
 * Preview component for create_item actions in the deferred tool workflow.
 * Shows a list of items that will be created. For single items, status icons
 * are hidden by default to provide a cleaner UI.
 */
export const CreateItemsPreview: React.FC<CreateItemsPreviewProps> = ({
    actions,
    status: propStatus,
    showStatusIcons,
}) => {
    // Compute overall status from actions if not provided
    const overallStatus = propStatus ?? getOverallStatus(actions);
    const isRejectedOrUndone = overallStatus === 'rejected' || overallStatus === 'undone';
    const isError = overallStatus === 'error';

    // Default behavior: hide status icons for single item, show for multiple
    const shouldShowStatusIcons = showStatusIcons ?? actions.length > 1;

    // Determine text styling based on overall status
    const getTextClasses = (defaultClass: string = 'font-color-primary') => {
        if (isRejectedOrUndone) return 'font-color-tertiary line-through';
        if (isError) return 'font-color-tertiary';
        return defaultClass;
    };

    return (
        <div className="create-items-preview px-3 py-2">
            <div className="display-flex flex-col gap-3">
                {actions.map((action, index) => {
                    const proposedData = action.proposed_data as CreateItemProposedData;
                    const resultData = action.result_data as CreateItemResultData | undefined;
                    const item = proposedData?.item;
                    const actionStatus = action.status as ActionStatus;
                    const statusIndicator = getStatusIndicator(actionStatus);

                    if (!item) {
                        return (
                            <div key={action.id} className="text-sm font-color-secondary">
                                No item data available
                            </div>
                        );
                    }

                    return (
                        <div 
                            key={action.id} 
                            className="display-flex flex-row items-start gap-2 py-1 border-bottom-quinary last:border-b-0"
                        >
                            {/* Status indicator - only show if enabled */}
                            {shouldShowStatusIcons && (
                                <div className="mt-015 flex-shrink-0 w-4">
                                    {statusIndicator.icon && (
                                        <Icon icon={statusIndicator.icon} className={statusIndicator.className} />
                                    )}
                                </div>
                            )}

                            {/* Item metadata */}
                            <div className="flex-1 min-w-0">
                                <ReferenceMetadataDisplay
                                    title={item.title}
                                    authors={item.authors}
                                    publicationTitle={item.journal?.name || item.venue}
                                    year={item.year}
                                    getTextClasses={getTextClasses}
                                />
                            </div>

                            {/* Reveal button (only for applied items) */}
                            {actionStatus === 'applied' && resultData?.library_id && resultData?.zotero_key && (
                                <Tooltip content="Reveal in Zotero" singleLine>
                                    <IconButton
                                        variant="ghost-secondary"
                                        icon={ArrowUpRightIcon}
                                        className="font-color-secondary scale-11 flex-shrink-0"
                                        onClick={() => revealSource({ 
                                            library_id: resultData.library_id, 
                                            zotero_key: resultData.zotero_key 
                                        })}
                                    />
                                </Tooltip>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default CreateItemsPreview;
