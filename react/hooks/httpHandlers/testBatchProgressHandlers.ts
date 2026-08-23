/**
 * Dev-only HTTP handlers for inspecting the batch progress bar.
 *
 * The bar renders from `metadata.batch_progress` on a tool return, which only
 * a real batch run produces — and a real run of each operation costs credits,
 * takes minutes, and cannot be made to sit at an interesting state on demand.
 * These handlers stage a synthetic stamp into run state instead, so the bar can
 * be looked at in every operation and every ledger state without one.
 *
 * Nothing here is a mock of the bar: the stamp goes through the same run state,
 * the same selector and the same component the backend's own stamp does. The
 * only thing faked is the run that produced it.
 *
 * Endpoints (wired in `useHttpEndpoints.ts`):
 *
 *   /beaver/test/batch-progress-preview  stage a synthetic stamp
 *   /beaver/test/batch-progress-clear    remove it again
 */

import { store } from '../../store';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { batchProgressAtom } from '../../atoms/agentRunAtoms';
import type {
    BatchProgressEntry,
    BatchProgressStamp,
} from '@beaver/agent-core/run-state/batchProgress';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';

/** Run id the preview run is stored under, so clearing removes only it. */
const PREVIEW_RUN_ID = 'batch-progress-preview';
const PREVIEW_TOOL_CALL_ID = 'batch-progress-preview-call';

/** A run carrying exactly one tool return, with the stamp on its metadata. */
function previewRun(stamp: BatchProgressStamp): AgentRun {
    const message: ModelMessage = {
        kind: 'request',
        run_id: PREVIEW_RUN_ID,
        instructions: '',
        parts: [
            {
                part_kind: 'tool-return',
                tool_name: 'organize_items',
                tool_call_id: PREVIEW_TOOL_CALL_ID,
                content: { status: 'applied' },
                metadata: { batch_progress: stamp },
            },
        ],
    } as ModelMessage;

    return {
        id: PREVIEW_RUN_ID,
        thread_id: store.get(activeRunAtom)?.thread_id ?? 'batch-progress-preview-thread',
        status: 'completed',
        user_prompt: { content: 'batch progress preview' },
        model_messages: [message],
        model_name: 'preview',
        created_at: new Date().toISOString(),
        consent_to_share: false,
    } as unknown as AgentRun;
}

function withoutPreview(runs: AgentRun[]): AgentRun[] {
    return runs.filter((run) => run.id !== PREVIEW_RUN_ID);
}

/**
 * Stage a synthetic progress stamp.
 *
 * Body: `{ batches: BatchProgressEntry[] }` — the stamp exactly as the backend
 * would send it, so a caller can reproduce any state the ledger can reach.
 */
export async function handleBatchProgressPreview(
    body: { batches?: BatchProgressEntry[] },
): Promise<{ ok: boolean; batches: number; tracked: string | null }> {
    const batches = Array.isArray(body?.batches) ? body.batches : [];
    const stamp: BatchProgressStamp = { batches };

    const runs = withoutPreview(store.get(threadRunsAtom) as AgentRun[]);
    store.set(threadRunsAtom, [...runs, previewRun(stamp)]);

    const current = store.get(batchProgressAtom);
    return {
        ok: true,
        batches: batches.length,
        tracked: current?.batches?.[0]?.batch_id ?? null,
    };
}

/** Remove the staged stamp. */
export async function handleBatchProgressClear(): Promise<{ ok: boolean }> {
    const runs = withoutPreview(store.get(threadRunsAtom) as AgentRun[]);
    store.set(threadRunsAtom, runs);
    return { ok: true };
}
