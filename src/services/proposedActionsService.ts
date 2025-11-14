import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ActionStatus, ActionResultDataType } from '../../react/types/chat/proposedActions';
import { logger } from '../utils/logger';

export interface AckLink {
    action_id: string;
    result_data: ActionResultDataType;
}

export interface AckRequest {
    message_id: string;
    links: AckLink[];
}

export interface AckError {
    action_id: string;
    code: 'not_found' | 'ownership' | 'zotero_key_conflict' | 'db_error';
    detail: string;
}

export interface AckResponse {
    success: boolean;
    message_id: string;
    updated: number;
    errors: AckError[];
}

export interface UpdateProposedActionRequest {
    status?: ActionStatus;
    error_message?: string | null;
    result_data?: Record<string, any>;
    validation_errors?: Record<string, any>;
}

export interface ProposedActionResponse {
    id: string;
    message_id: string;
    action_type: string;
    status: ActionStatus;
    result_data?: Record<string, any> | null;
    error_message?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface UpdateProposedActionResponse {
    success: boolean;
    action: ProposedActionResponse;
}

export interface BatchUpdateItem {
    action_id: string;
    status?: ActionStatus;
    error_message?: string | null;
    result_data?: Record<string, any>;
    validation_errors?: Record<string, any>;
}

export interface BatchUpdateRequest {
    updates: BatchUpdateItem[];
}

export interface BatchUpdateError {
    action_id: string;
    code: 'not_found' | 'no_fields' | 'db_error';
    detail: string;
}

export interface BatchUpdateResponse {
    success: boolean;
    updated: number;
    errors: BatchUpdateError[];
}

type UpdateResolution = {
    resolve: (value: UpdateProposedActionResponse) => void;
    reject: (reason: unknown) => void;
};

type PendingActionUpdate = {
    updates: UpdateProposedActionRequest;
    requests: UpdateResolution[];
};

type BatchedActionUpdate = {
    actionId: string;
    updates: UpdateProposedActionRequest;
    requests: UpdateResolution[];
};

const UPDATE_FLUSH_INTERVAL_MS = 100;
const MAX_PENDING_UPDATE_ENTRIES = 25;

class ProposedActionUpdateBatcher {
    private pendingUpdates = new Map<string, PendingActionUpdate>();
    private timer: NodeJS.Timeout | null = null;
    private isFlushing = false;
    private flushRequestedWhileRunning = false;

    constructor(
        private readonly dispatchUpdates: (
            updates: BatchedActionUpdate[]
        ) => Promise<BatchUpdateResponse>
    ) {}

    enqueue(actionId: string, updates: UpdateProposedActionRequest): Promise<UpdateProposedActionResponse> {
        const mergedUpdates = { ...updates };

        return new Promise<UpdateProposedActionResponse>((resolve, reject) => {
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
                logger(`ProposedActionUpdateBatcher: flush error: ${error?.message || error}`, 1);
            });
        }, UPDATE_FLUSH_INTERVAL_MS);
    }

    private triggerImmediateFlush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.flush().catch((error) => {
            logger(`ProposedActionUpdateBatcher: immediate flush error: ${error?.message || error}`, 1);
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
            const errorMap = new Map<string, BatchUpdateError>();
            response.errors.forEach((error) => errorMap.set(error.action_id, error));

            entries.forEach((entry) => {
                const error = errorMap.get(entry.actionId);
                if (error) {
                    const err = new Error(`${error.code}: ${error.detail}`);
                    entry.requests.forEach(({ reject }) => reject(err));
                } else {
                    const updateResponse: UpdateProposedActionResponse = {
                        success: true,
                        action: {
                            id: entry.actionId,
                            message_id: '',
                            action_type: '',
                            status: entry.updates.status || 'pending',
                            result_data: entry.updates.result_data,
                            error_message: entry.updates.error_message,
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

export class ProposedActionsService extends ApiService {
    private readonly updateBatcher: ProposedActionUpdateBatcher;

    constructor(backendUrl: string) {
        super(backendUrl);
        this.updateBatcher = new ProposedActionUpdateBatcher((entries) =>
            this.dispatchActionUpdates(entries)
        );
    }

    getBaseUrl(): string {
        return this.baseUrl;
    }

    async acknowledgeActions(
        messageId: string,
        links: AckLink[]
    ): Promise<AckResponse> {
        logger(`acknowledgeActions: Acknowledging ${links.length} actions for message ${messageId}`);

        const request: AckRequest = {
            message_id: messageId,
            links,
        };

        return this.post<AckResponse>('/api/v1/proposed-actions/ack', request);
    }

    async updateAction(actionId: string, updates: UpdateProposedActionRequest): Promise<UpdateProposedActionResponse> {
        logger(`updateAction: Updating action ${actionId} with fields: ${Object.keys(updates).join(', ')}`);
        return this.updateBatcher.enqueue(actionId, updates).then((response) => {
            logger(`updateAction: Successfully updated action ${actionId}`);
            return response;
        });
    }

    async updateActionStatusBatch(
        actionIds: string[],
        status: ActionStatus,
        errorMessage?: string
    ): Promise<UpdateProposedActionResponse[]> {
        logger(`updateActionStatusBatch: Updating ${actionIds.length} actions to status: ${status}`);

        const updates: UpdateProposedActionRequest = { status };
        if (errorMessage) {
            updates.error_message = errorMessage;
        }

        const responses = await Promise.all(
            actionIds.map((id) => this.updateAction(id, updates))
        );

        logger(`updateActionStatusBatch: Successfully updated ${responses.length} actions`);
        return responses;
    }

    async markActionsFailed(
        actionIds: string[],
        errorMessage: string
    ): Promise<UpdateProposedActionResponse[]> {
        return this.updateActionStatusBatch(actionIds, 'error', errorMessage);
    }

    async markActionsUndone(actionIds: string[]): Promise<UpdateProposedActionResponse[]> {
        return this.updateActionStatusBatch(actionIds, 'undone');
    }

    dispose(): void {
        this.updateBatcher.dispose();
    }

    private async dispatchActionUpdates(
        entries: BatchedActionUpdate[]
    ): Promise<BatchUpdateResponse> {
        const request: BatchUpdateRequest = {
            updates: entries.map(({ actionId, updates }) => ({
                action_id: actionId,
                ...updates,
            })),
        };

        return super.patch<BatchUpdateResponse>(
            '/api/v1/proposed-actions/batch',
            request
        );
    }
}

export const proposedActionsService = new ProposedActionsService(API_BASE_URL);

