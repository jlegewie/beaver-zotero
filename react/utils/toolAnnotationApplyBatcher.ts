import { store } from '../store';
import { currentReaderAttachmentKeyAtom } from '../atoms/messageComposition';
import { agentActionsService, AckActionLink } from '../../src/services/agentActionsService';
import { logger } from '../../src/utils/logger';
import { AnnotationResultData } from '../types/agentActions/base';
import { updateAgentActionsAtom, AgentAction, AgentActionUpdate, isAnnotationAgentAction } from '../agents/agentActions';
import { applyAnnotation } from './annotationActions';

const DEFAULT_FLUSH_TIMEOUT_MS = 250;
const MAX_QUEUE_SIZE = 50;

/**
 * Typed agent action for annotations (mirrors AnnotationProposedAction structure)
 */
type AnnotationAgentAction = AgentAction & {
    action_type: 'highlight_annotation' | 'note_annotation';
    proposed_data: {
        library_id: number;
        attachment_key: string;
        [key: string]: any;
    };
    result_data?: AnnotationResultData;
};

type AnnotationBatchItem = {
    runId: string;
    toolcallId: string;
    actions: AnnotationAgentAction[];
};

type AckEntry = {
    toolcallId: string;
    action: AnnotationAgentAction;
};

export class ToolAnnotationApplyBatcher {
    private queue: AnnotationBatchItem[] = [];
    private timer: NodeJS.Timeout | null = null;
    private isFlushing = false;
    private flushRequestedWhileRunning = false;
    private readonly flushTimeoutMs: number;

    public constructor(flushTimeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS) {
        this.flushTimeoutMs = flushTimeoutMs;
    }

    public enqueue(item: AnnotationBatchItem): void {
        if (item.actions.length === 0) {
            return;
        }

        this.queue.push(item);
        
        // Proactively flush if queue size exceeds threshold
        if (this.queue.length >= MAX_QUEUE_SIZE) {
            logger(`AnnotationBatcher: proactive flush queue size ${this.queue.length} exceeds threshold ${MAX_QUEUE_SIZE}`, 1);
            // Cancel scheduled flush and flush immediately
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            this.flush().catch((error) => {
                logger(`AnnotationBatcher: proactive flush error: ${error?.message || error}`, 1);
            });
        } else {
            this.scheduleFlush();
        }
    }

    private scheduleFlush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.flush().catch((error) => {
                logger(`AnnotationBatcher: flush error: ${error?.message || error}`, 1);
            });
        }, this.flushTimeoutMs);
    }

    private async flush(): Promise<void> {
        if (this.isFlushing) {
            this.flushRequestedWhileRunning = true;
            return;
        }

        this.isFlushing = true;
        try {
            await this.flushInternal();
        } finally {
            this.isFlushing = false;
            if (this.flushRequestedWhileRunning) {
                this.flushRequestedWhileRunning = false;
                if (this.queue.length > 0) {
                    await this.flush();
                }
            }
        }
    }

    private async flushInternal(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.queue.length === 0) {
            return;
        }

        const batch = this.queue;
        this.queue = [];

        const currentReaderKey = store.get(currentReaderAttachmentKeyAtom);
        if (!currentReaderKey) {
            logger('AnnotationBatcher: no current reader, skipping annotation application', 2);
        }

        const ackRequests = new Map<string, AckEntry[]>();
        const ackIndex = new Map<string, AckEntry>();
        const ackErrorUpdates: AgentActionUpdate[] = [];
        const errorActionsToPersist: Array<{ actionId: string; errorMessage: string }> = [];
        const ackErrorsToPersist: Array<{ actionId: string; detail: string }> = [];

        for (const item of batch) {
            const appliedActions = await Promise.all(
                item.actions.map((action) => this.applySingleAction(action, currentReaderKey))
            );

            // Update state for all actions in this batch item
            store.set(updateAgentActionsAtom, 
                appliedActions.map((action) => ({
                    id: action.id,
                    status: action.status,
                    result_data: action.result_data,
                    error_message: action.error_message,
                }))
            );

            appliedActions
                .filter((action) => action.status === 'applied' && action.result_data?.zotero_key)
                .forEach((action) => {
                    const existing = ackIndex.get(action.id);
                    if (existing) {
                        logger(`AnnotationBatcher: duplicate action ${action.id} received for ack, ignoring duplicate`, 2);
                        return;
                    }

                    const entry: AckEntry = { toolcallId: item.toolcallId, action };
                    if (!ackRequests.has(item.runId)) {
                        ackRequests.set(item.runId, []);
                    }
                    ackRequests.get(item.runId)!.push(entry);
                    ackIndex.set(action.id, entry);
                });

            appliedActions
                .filter((action) => action.status === 'error')
                .forEach((action) => {
                    errorActionsToPersist.push({
                        actionId: action.id,
                        errorMessage: action.error_message || 'Failed to apply action',
                    });
                });
        }

        for (const [runId, entries] of ackRequests.entries()) {
            try {
                const links: AckActionLink[] = entries.map(({ action }) => ({
                    action_id: action.id,
                    result_data: action.result_data as AnnotationResultData,
                }));

                const response = await agentActionsService.acknowledgeActions(runId, links);

                if (response.errors.length > 0) {
                    response.errors.forEach((ackError) => {
                        const entry = ackIndex.get(ackError.action_id);
                        if (!entry) {
                            logger(
                                `AnnotationBatcher: ack error for unknown action ${ackError.action_id}: ${ackError.detail}`,
                                1
                            );
                            return;
                        }

                        ackErrorUpdates.push({
                            id: ackError.action_id,
                            status: 'error',
                            error_message: ackError.detail,
                        });
                        ackErrorsToPersist.push({
                            actionId: ackError.action_id,
                            detail: ackError.detail,
                        });
                    });
                }
            } catch (error: any) {
                logger(
                    `AnnotationBatcher: failed to acknowledge actions for run ${runId}: ${error?.message || error}`,
                    1
                );
            }
        }

        if (ackErrorUpdates.length > 0) {
            store.set(updateAgentActionsAtom, ackErrorUpdates);
        }

        const backendUpdatePromises: Promise<void>[] = [];

        errorActionsToPersist.forEach(({ actionId, errorMessage }) => {
            backendUpdatePromises.push((async () => {
                try {
                    await agentActionsService.updateAction(actionId, {
                        status: 'error',
                        error_message: errorMessage,
                    });
                } catch (error: any) {
                    logger(
                        `AnnotationBatcher: failed to persist error status for action ${actionId}: ${error?.message || error}`,
                        1
                    );
                }
            })());
        });

        ackErrorsToPersist.forEach(({ actionId, detail }) => {
            backendUpdatePromises.push((async () => {
                try {
                    await agentActionsService.updateAction(actionId, {
                        status: 'error',
                        error_message: detail,
                    });
                } catch (error: any) {
                    logger(
                        `AnnotationBatcher: failed to update backend for ack error ${actionId}: ${error?.message || error}`,
                        1
                    );
                }
            })());
        });

        if (backendUpdatePromises.length > 0) {
            await Promise.all(backendUpdatePromises);
        }
    }

    private async applySingleAction(
        action: AnnotationAgentAction,
        currentReaderKey: string | null
    ): Promise<AnnotationAgentAction> {
        if (!currentReaderKey || !action.proposed_data?.attachment_key) {
            return action;
        }

        if (action.proposed_data.attachment_key !== currentReaderKey) {
            return action;
        }

        try {
            // Cast to AnnotationProposedAction for applyAnnotation compatibility
            // Both AgentAction and ProposedAction share the same proposed_data structure
            const result = await applyAnnotation(action as any);
            logger(`AnnotationBatcher: applied action ${action.id}`, 1);

            return {
                ...action,
                status: 'applied',
                result_data: result,
            };
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply action';
            logger(`AnnotationBatcher: failed to apply action ${action.id}: ${errorMessage}`, 1);
            return {
                ...action,
                status: 'error',
                error_message: errorMessage
            };
        }
    }

    public dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.queue = [];
    }
}

export const toolAnnotationApplyBatcher = new ToolAnnotationApplyBatcher();

/**
 * Helper to filter annotation agent actions from a list
 */
export function filterAnnotationAgentActions(actions: AgentAction[]): AnnotationAgentAction[] {
    return actions.filter(isAnnotationAgentAction) as AnnotationAgentAction[];
}
