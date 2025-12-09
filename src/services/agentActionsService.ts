import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ActionStatus, ActionResultDataType } from '../../react/types/proposedActions/base';
import { logger } from '../utils/logger';

// ============================================================================
// Request/Response Types
// ============================================================================

export interface AckActionLink {
    action_id: string;
    result_data: ActionResultDataType;
}

export interface AckActionsRequest {
    run_id: string;
    links: AckActionLink[];
}

export interface AckActionError {
    action_id: string;
    code: 'not_found' | 'no_fields';
    detail: string;
}

export interface AckActionsResponse {
    success: boolean;
    run_id: string;
    updated: number;
    errors: AckActionError[];
}

export interface UpdateActionRequest {
    status?: ActionStatus;
    error_message?: string;
    result_data?: Record<string, any>;
    error_details?: Record<string, any>;
}

export interface ActionResponse {
    id: string;
    run_id: string;
    toolcall_id?: string;
    action_type: string;
    status: string;
    proposed_data: Record<string, any>;
    result_data?: Record<string, any>;
    created_at: string;
    updated_at: string;
}

export interface UpdateActionResponse {
    success: boolean;
    action: ActionResponse;
}

export interface BatchUpdateActionItem {
    action_id: string;
    status?: ActionStatus;
    error_message?: string;
    result_data?: Record<string, any>;
    error_details?: Record<string, any>;
    clear_error_message?: boolean;
    clear_result_data?: boolean;
    clear_error_details?: boolean;
}

export interface BatchUpdateActionsRequest {
    updates: BatchUpdateActionItem[];
}

export interface BatchUpdateActionError {
    action_id: string;
    code: 'not_found' | 'no_fields';
    detail: string;
}

export interface BatchUpdateActionsResponse {
    success: boolean;
    updated: number;
    errors: BatchUpdateActionError[];
}

// ============================================================================
// Update Batcher
// ============================================================================

type UpdateResolution = {
    resolve: (value: UpdateActionResponse) => void;
    reject: (reason: unknown) => void;
};

type PendingActionUpdate = {
    updates: UpdateActionRequest;
    requests: UpdateResolution[];
};

type BatchedActionUpdate = {
    actionId: string;
    updates: UpdateActionRequest;
    requests: UpdateResolution[];
};

const UPDATE_FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_UPDATE_ENTRIES = 25;

class AgentActionUpdateBatcher {
    private pendingUpdates = new Map<string, PendingActionUpdate>();
    private timer: NodeJS.Timeout | null = null;
    private isFlushing = false;
    private flushRequestedWhileRunning = false;

    constructor(
        private readonly dispatchUpdates: (
            updates: BatchedActionUpdate[]
        ) => Promise<BatchUpdateActionsResponse>
    ) {}

    enqueue(actionId: string, updates: UpdateActionRequest): Promise<UpdateActionResponse> {
        const mergedUpdates = { ...updates };

        return new Promise<UpdateActionResponse>((resolve, reject) => {
            const existing = this.pendingUpdates.get(actionId);
            if (existing) {
                existing.updates = { ...existing.updates, ...mergedUpdates };
                existing.requests.push({ resolve, reject });
            } else {
                this.pendingUpdates.set(actionId, {
                    updates: mergedUpdates,
                    requests: [{ resolve, reject }]
                });
            }

            if (this.pendingUpdates.size >= MAX_PENDING_UPDATE_ENTRIES) {
                this.triggerImmediateFlush();
            } else {
                this.scheduleFlush();
            }
        });
    }

    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pendingUpdates.clear();
    }

    private scheduleFlush(): void {
        if (this.timer) {
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch((error) => {
                logger(`AgentActionUpdateBatcher: flush error: ${error?.message || error}`, 1);
            });
        }, UPDATE_FLUSH_INTERVAL_MS);
    }

    private triggerImmediateFlush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.flush().catch((error) => {
            logger(`AgentActionUpdateBatcher: immediate flush error: ${error?.message || error}`, 1);
        });
    }

    private async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.isFlushing) {
            this.flushRequestedWhileRunning = true;
            return;
        }

        this.isFlushing = true;
        try {
            while (this.pendingUpdates.size > 0) {
                const batchedEntries = Array.from(this.pendingUpdates.entries()).map(
                    ([actionId, entry]): BatchedActionUpdate => ({
                        actionId,
                        updates: entry.updates,
                        requests: entry.requests
                    })
                );
                this.pendingUpdates.clear();

                await this.dispatchAndResolve(batchedEntries);
            }
        } finally {
            this.isFlushing = false;
            if (this.flushRequestedWhileRunning) {
                this.flushRequestedWhileRunning = false;
                if (this.pendingUpdates.size > 0) {
                    await this.flush();
                }
            }
        }
    }

    private async dispatchAndResolve(entries: BatchedActionUpdate[]): Promise<void> {
        if (entries.length === 0) {
            return;
        }

        try {
            const response = await this.dispatchUpdates(entries);
            const errorMap = new Map<string, BatchUpdateActionError>();
            response.errors.forEach((error) => errorMap.set(error.action_id, error));

            entries.forEach((entry) => {
                const error = errorMap.get(entry.actionId);
                if (error) {
                    const err = new Error(`${error.code}: ${error.detail}`);
                    entry.requests.forEach(({ reject }) => reject(err));
                } else {
                    const updateResponse: UpdateActionResponse = {
                        success: true,
                        action: {
                            id: entry.actionId,
                            run_id: '',
                            action_type: '',
                            status: entry.updates.status || 'pending',
                            proposed_data: {},
                            result_data: entry.updates.result_data,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                        },
                    };
                    entry.requests.forEach(({ resolve }) => resolve(updateResponse));
                }
            });
        } catch (error) {
            entries.forEach((entry) => entry.requests.forEach(({ reject }) => reject(error)));
        }
    }
}

// ============================================================================
// Agent Actions Service
// ============================================================================

export class AgentActionsService extends ApiService {
    private readonly updateBatcher: AgentActionUpdateBatcher;

    constructor(backendUrl: string) {
        super(backendUrl);
        this.updateBatcher = new AgentActionUpdateBatcher((entries) =>
            this.dispatchActionUpdates(entries)
        );
    }

    getBaseUrl(): string {
        return this.baseUrl;
    }

    /**
     * Acknowledge that specific actions were successfully applied (e.g., created in Zotero)
     * Sets result_data and updates status to 'applied'
     */
    async acknowledgeActions(
        runId: string,
        links: AckActionLink[]
    ): Promise<AckActionsResponse> {
        logger(`acknowledgeActions: Acknowledging ${links.length} actions for run ${runId}`);

        const request: AckActionsRequest = {
            run_id: runId,
            links,
        };

        return this.post<AckActionsResponse>('/api/v1/agent-actions/ack', request);
    }

    /**
     * Update a single action's status or data (batched for efficiency)
     */
    async updateAction(actionId: string, updates: UpdateActionRequest): Promise<UpdateActionResponse> {
        logger(`updateAction: Updating action ${actionId} with fields: ${Object.keys(updates).join(', ')}`);
        return this.updateBatcher.enqueue(actionId, updates).then((response) => {
            logger(`updateAction: Successfully updated action ${actionId}`);
            return response;
        });
    }

    /**
     * Update multiple actions to the same status (convenience method)
     */
    async updateActionStatusBatch(
        actionIds: string[],
        status: ActionStatus,
        errorMessage?: string
    ): Promise<UpdateActionResponse[]> {
        logger(`updateActionStatusBatch: Updating ${actionIds.length} actions to status: ${status}`);

        const updates: UpdateActionRequest = { status };
        if (errorMessage) {
            updates.error_message = errorMessage;
        }

        const responses = await Promise.all(
            actionIds.map((id) => this.updateAction(id, updates))
        );

        logger(`updateActionStatusBatch: Successfully updated ${responses.length} actions`);
        return responses;
    }

    /**
     * Mark multiple actions as failed with an error message
     */
    async markActionsFailed(
        actionIds: string[],
        errorMessage: string
    ): Promise<UpdateActionResponse[]> {
        return this.updateActionStatusBatch(actionIds, 'error', errorMessage);
    }

    /**
     * Mark multiple actions as undone
     */
    async markActionsUndone(actionIds: string[]): Promise<UpdateActionResponse[]> {
        return this.updateActionStatusBatch(actionIds, 'undone');
    }

    /**
     * Get all agent actions for a specific run
     */
    async getActionsForRun(runId: string): Promise<ActionResponse[]> {
        logger(`getActionsForRun: Fetching actions for run ${runId}`);
        return this.get<ActionResponse[]>(`/api/v1/agent-actions/run/${runId}`);
    }

    dispose(): void {
        this.updateBatcher.dispose();
    }

    private async dispatchActionUpdates(
        entries: BatchedActionUpdate[]
    ): Promise<BatchUpdateActionsResponse> {
        const request: BatchUpdateActionsRequest = {
            updates: entries.map(({ actionId, updates }) => ({
                action_id: actionId,
                ...updates,
            })),
        };

        return super.patch<BatchUpdateActionsResponse>(
            '/api/v1/agent-actions/batch',
            request
        );
    }
}

export const agentActionsService = new AgentActionsService(API_BASE_URL);

