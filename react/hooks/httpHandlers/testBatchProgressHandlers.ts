/**
 * Dev-only HTTP handlers for inspecting the batch progress bar.
 *
 * Stage a synthetic stamp into run state so the bar can be looked at without a
 * real (credit-consuming) batch run. The stamp goes through the same selector
 * and component as a backend stamp.
 *
 * `runStatus` picks which surface a batch is previewed on: `in_progress` for the
 * panel (open batches only), `completed` for the receipt (ended batches only —
 * a terminal run's open batch is paused, and no surface draws one). Default
 * `in_progress` also shows the preview run's status indicator, matching a live
 * run. An entry with `paused: true` is drawn nowhere, whatever the run status.
 *
 * The response says where the batches landed, so a caller can tell the two
 * surfaces apart without reading the DOM.
 *
 *   /beaver/test/batch-progress-preview  stage a synthetic stamp
 *   /beaver/test/batch-progress-clear    remove it again
 */

import { store } from '../../store';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { batchProgressAtom } from '../../atoms/agentRunAtoms';
import { isRunActive } from '@beaver/agent-core/agents/types';
import {
    hasBatchEnded,
    selectBatchPanelGroups,
    selectRunBatchOutcomes,
} from '@beaver/agent-core/run-state/batchProgress';
import type {
    BatchProgressEntry,
    BatchProgressStamp,
} from '@beaver/agent-core/run-state/batchProgress';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';

/** Run id the preview run is stored under, so clearing removes only it. */
const PREVIEW_RUN_ID = 'batch-progress-preview';
const PREVIEW_TOOL_CALL_ID = 'batch-progress-preview-call';

/** Which surface an ended preview batch is drawn on. */
type PreviewRunStatus = 'in_progress' | 'completed';

/** A run carrying exactly one tool return, with the stamp on its metadata. */
function previewRun(stamp: BatchProgressStamp, status: PreviewRunStatus): AgentRun {
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
        status,
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
 * Body: `{ batches: BatchProgressEntry[], runStatus? }` — the stamp exactly as
 * the backend would send it, so a caller can reproduce any state the ledger can
 * reach. `runStatus` defaults to `in_progress`, the state the panel draws in.
 */
export async function handleBatchProgressPreview(
    body: { batches?: BatchProgressEntry[]; runStatus?: PreviewRunStatus },
): Promise<{
    ok: boolean;
    batches: number;
    tracked: string | null;
    /** Batch ids the panel above the composer accounts for, disclosures included. */
    panel: string[];
    /** Batch ids the run's receipt accounts for, disclosures included. */
    receipt: string[];
}> {
    const batches = Array.isArray(body?.batches) ? body.batches : [];
    const stamp: BatchProgressStamp = { batches };
    const runStatus: PreviewRunStatus = body?.runStatus === 'completed' ? 'completed' : 'in_progress';

    const runs = withoutPreview(store.get(threadRunsAtom) as AgentRun[]);
    const staged = previewRun(stamp, runStatus);
    store.set(threadRunsAtom, [...runs, staged]);

    // Report what each surface draws, not what it was handed.
    const groups = selectBatchPanelGroups(store.get(batchProgressAtom));
    // Open batch and queue only. The panel's brief hold after completion is
    // transient and is not reported here.
    const panel =
        groups.tracked && !hasBatchEnded(groups.tracked)
            ? [groups.tracked, ...groups.queued].map((entry) => entry.batch_id)
            : [];
    return {
        ok: true,
        batches: batches.length,
        tracked: panel.length ? (groups.tracked?.batch_id ?? null) : null,
        panel,
        // `BatchRunReceipt` draws nothing until the run is terminal, which the
        // selector alone does not know.
        receipt: isRunActive(staged)
            ? []
            : selectRunBatchOutcomes(staged).map((entry) => entry.batch_id),
    };
}

/** Remove the staged stamp. */
export async function handleBatchProgressClear(): Promise<{ ok: boolean }> {
    const runs = withoutPreview(store.get(threadRunsAtom) as AgentRun[]);
    store.set(threadRunsAtom, runs);
    return { ok: true };
}
