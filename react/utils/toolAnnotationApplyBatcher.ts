import { store } from '../store';
import { currentReaderAttachmentKeyAtom } from '../atoms/input';
import { toolAnnotationsService } from '../../src/services/toolAnnotationsService';
import { logger } from '../../src/utils/logger';
import { ToolAnnotation } from '../types/chat/toolAnnotations';
import { AnnotationUpdates, updateToolcallAnnotationsAtom, upsertToolcallAnnotationAtom } from '../atoms/toolAnnotations';
import { applyAnnotation } from './toolAnnotationActions';

const DEFAULT_FLUSH_TIMEOUT_MS = 250;
const MAX_QUEUE_SIZE = 50;

type AnnotationBatchItem = {
    messageId: string;
    toolcallId: string;
    annotations: ToolAnnotation[];
};

type AckEntry = {
    toolcallId: string;
    annotation: ToolAnnotation;
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
        if (item.annotations.length === 0) {
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
        const ackRequests = new Map<string, AckEntry[]>();
        const ackIndex = new Map<string, AckEntry>();
        const errorAnnotationsToPersist: Array<{ annotation: ToolAnnotation }> = [];
        const ackErrorUpdatesByToolcall = new Map<string, AnnotationUpdates[]>();
        const ackErrorsToPersist: Array<{ annotationId: string; detail: string }> = [];

        for (const item of batch) {
            const appliedAnnotations = await Promise.all(
                item.annotations.map((annotation) => this.applySingleAnnotation(annotation, currentReaderKey))
            );

            store.set(upsertToolcallAnnotationAtom, {
                toolcallId: item.toolcallId,
                annotations: appliedAnnotations,
            });

            appliedAnnotations
                .filter((annotation) => annotation.status === 'applied' && Boolean(annotation.zotero_key))
                .forEach((annotation) => {
                    const existing = ackIndex.get(annotation.id);
                    if (existing) {
                        logger(`AnnotationBatcher: duplicate annotation ${annotation.id} received for ack, ignoring duplicate`, 2);
                        return;
                    }

                    const entry: AckEntry = { toolcallId: item.toolcallId, annotation };
                    if (!ackRequests.has(item.messageId)) {
                        ackRequests.set(item.messageId, []);
                    }
                    ackRequests.get(item.messageId)!.push(entry);
                    ackIndex.set(annotation.id, entry);
                });

            appliedAnnotations
                .filter((annotation) => annotation.status === 'error')
                .forEach((annotation) => {
                    errorAnnotationsToPersist.push({ annotation });
                });
        }

        for (const [messageId, entries] of ackRequests.entries()) {
            try {
                const response = await toolAnnotationsService.markAnnotationsApplied(
                    messageId,
                    entries.map(({ annotation }) => ({
                        annotationId: annotation.id,
                        zoteroKey: annotation.zotero_key as string,
                    }))
                );

                if (response.errors.length > 0) {
                    response.errors.forEach((ackError) => {
                        const entry = ackIndex.get(ackError.annotation_id);
                        if (!entry) {
                            logger(
                                `AnnotationBatcher: ack error for unknown annotation ${ackError.annotation_id}: ${ackError.detail}`,
                                1
                            );
                            return;
                        }

                        const updates = ackErrorUpdatesByToolcall.get(entry.toolcallId) || [];
                        updates.push({
                            annotationId: ackError.annotation_id,
                            updates: {
                                status: 'error',
                                error_message: ackError.detail,
                                modified_at: new Date().toISOString(),
                            },
                        });
                        ackErrorUpdatesByToolcall.set(entry.toolcallId, updates);
                        ackErrorsToPersist.push({
                            annotationId: ackError.annotation_id,
                            detail: ackError.detail,
                        });
                    });
                }
            } catch (error: any) {
                logger(
                    `AnnotationBatcher: failed to acknowledge annotations for message ${messageId}: ${error?.message || error}`,
                    1
                );
            }
        }

        for (const [toolcallId, updates] of ackErrorUpdatesByToolcall.entries()) {
            store.set(updateToolcallAnnotationsAtom, {
                toolcallId,
                updates,
            });
        }

        const backendUpdatePromises: Promise<void>[] = [];

        errorAnnotationsToPersist.forEach(({ annotation }) => {
            backendUpdatePromises.push((async () => {
                try {
                    await toolAnnotationsService.updateAnnotation(annotation.id, {
                        status: 'error',
                        error_message: annotation.error_message || 'Failed to apply annotation',
                    });
                } catch (error: any) {
                    logger(
                        `AnnotationBatcher: failed to persist error status for annotation ${annotation.id}: ${error?.message || error}`,
                        1
                    );
                }
            })());
        });

        ackErrorsToPersist.forEach(({ annotationId, detail }) => {
            backendUpdatePromises.push((async () => {
                try {
                    await toolAnnotationsService.updateAnnotation(annotationId, {
                        status: 'error',
                        error_message: detail,
                    });
                } catch (error: any) {
                    logger(
                        `AnnotationBatcher: failed to update backend for ack error ${annotationId}: ${error?.message || error}`,
                        1
                    );
                }
            })());
        });

        if (backendUpdatePromises.length > 0) {
            await Promise.all(backendUpdatePromises);
        }
    }

    private async applySingleAnnotation(
        annotation: ToolAnnotation,
        currentReaderKey: string | null
    ): Promise<ToolAnnotation> {
        if (!currentReaderKey) {
            return annotation;
        }

        if (annotation.attachment_key !== currentReaderKey) {
            return annotation;
        }

        try {
            const result = await applyAnnotation(annotation);
            if (!result.updated) {
                return annotation;
            }

            if (result.annotation.status === 'applied') {
                logger(`AnnotationBatcher: applied annotation ${result.annotation.id}`, 1);
            }

            if (result.annotation.status === 'error') {
                logger(
                    `AnnotationBatcher: error applying annotation ${result.annotation.id}: ${result.annotation.error_message}`,
                    1
                );
            }

            return {
                ...result.annotation,
                ...(result.annotation.status === 'error' && !result.annotation.error_message
                    ? { error_message: result.error || 'Failed to create annotation' }
                    : {}),
            };
        } catch (error: any) {
            const errorMessage = error?.message || 'Failed to apply annotation';
            logger(`AnnotationBatcher: failed to apply annotation ${annotation.id}: ${errorMessage}`, 1);
            return {
                ...annotation,
                status: 'error',
                error_message: errorMessage,
                modified_at: new Date().toISOString(),
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
