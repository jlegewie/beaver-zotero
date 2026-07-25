/**
 * Waiting out a run the backend is still finishing.
 *
 * When a run is interrupted — the panel closed, Zotero quit, the connection
 * dropped, the server was redeployed — the backend saves whatever the agent had
 * produced and marks the run `canceled`. That save is fast, but it is not
 * instant, and the row starts life as `in_progress` with no messages at all.
 *
 * A thread opened inside that window therefore reads a run that looks finished
 * and empty. Rewriting it to `canceled` there and then renders the answer as a
 * blank turn, and nothing ever refetches it — so a partial answer that landed
 * 300ms later stays invisible until the user navigates away and back.
 *
 * So: leave it `in_progress`, show that we are waiting, and ask again a few
 * times. If it settles, merge it in. If it never does, fall back to exactly
 * what used to happen — a locally canceled run — because nothing reaps a row
 * that is stuck, and a spinner that never stops is worse than an empty turn.
 */
import { atom, Getter, Setter } from 'jotai';

import { agentRunService } from '../../src/services/agentService';
import { logger } from '../../src/utils/logger';
import { ApiError } from '../types/apiErrors';
import { AgentRun } from '../agents/types';
import { Citation } from '../types/citations';
import { AgentAction, isCreateItemAgentAction, threadAgentActionsAtom } from '../agents/agentActions';
import { addExternalReferencesToMappingAtom, checkExternalReferencesAtom } from './externalReferences';
import { ExternalReference } from '../types/externalReferences';
import { threadRunsAtom, activeRunAtom } from '../agents/atoms';
import { replaceRunById } from '../agents/runResumeHelpers';
import { processToolReturnResults } from '../agents/toolResultProcessing';
import { upgradeToolReturn } from '../compat/legacyToolResults';
import { citationsAtom, processCitationsAtom, mergePageLabelsByAttachmentIdAtom } from './citations';
import { preloadPageLabelsForCitations } from '../utils/pageLabels';
import { loadItemDataForAgentActions } from '../utils/agentActionUtils';
import { currentThreadIdAtom, reconcileToolcallIds } from './threads';

/**
 * Runs we are currently waiting on. Drives the "Finishing up…" copy and doubles
 * as the guard against scheduling the same run twice — two Beaver windows share
 * one store, so both would otherwise start their own timer.
 */
export const recoveringRunIdsAtom = atom<Set<string>>(new Set<string>());

/**
 * Bumped by every thread load. A recovery captures it and stands down once it
 * changes, which is what stops a wait left over from an earlier load acting on
 * a later one — the run id and the thread id can both be identical after the
 * user switches away and back, so neither of them can tell the two apart.
 */
export const threadLoadGenerationAtom = atom(0);

/**
 * Delays before each refetch. The first is not zero on purpose: the thread load
 * that got us here read `in_progress` a moment ago, so an immediate retry would
 * almost certainly read it again. Jitter keeps two windows from asking in step.
 */
const REFETCH_BACKOFF_MS: ReadonlyArray<{ min: number; max: number }> = [
    { min: 200, max: 400 },
    { min: 400, max: 800 },
    { min: 800, max: 1600 },
    { min: 1500, max: 2500 },
];

/**
 * How long to wait on one refetch before giving up on it.
 *
 * The API layer has no request timeout and no abort signal, so a half-open
 * connection would otherwise leave this loop waiting forever — the spinner
 * would never stop and the run would never settle, which is worse than the
 * empty turn this all exists to avoid. Losing the race does not cancel the
 * request (nothing can); it just stops us waiting on it.
 */
const REFETCH_TIMEOUT_MS = 5000;

/**
 * When to look again for the backend's *later* writes — the ones carrying
 * citations and note proposals — after the run's status has already flipped.
 *
 * The status and the citations are written separately on purpose: resolving
 * citations needs a round trip to the plugin, and making the run wait for that
 * is what left reopened threads showing a blank answer. The cost is this
 * window, where a run reads as settled but its sources have not landed.
 *
 * Two attempts rather than one because the far side is not a single deadline we
 * can mirror: `interrupt_enrich_timeout` (3s by default) bounds only the
 * resolution, and the writes that follow it can retry. Spreading the look over
 * ~6s tolerates that without pinning us to another service's exact timing. A
 * deployment that raises that setting well above its default will fall outside
 * this window, and those citations then wait for the next thread load.
 */
const LATE_METADATA_BACKOFF_MS: ReadonlyArray<number> = [2000, 4000];

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitteredDelay(range: { min: number; max: number }): number {
    return range.min + Math.random() * (range.max - range.min);
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    // Promise.race attaches handlers to `work`, so a later rejection from the
    // abandoned request is still considered handled.
    return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Whether it is still meaningful to wait for this run, re-read after every
 * await. Atom-level async work has no cancellation, so the only safe pattern is
 * to check that the world has not moved before touching it.
 *
 * The three reads cover every writer that could invalidate us: a thread switch
 * or reset (the thread id changed), a live stream taking over this id, and a
 * truncation or a settled status (the run is gone, or someone else finished it).
 */
function stillRecoverable(
    get: Getter,
    runId: string,
    threadId: string,
    generation: number,
): boolean {
    if (!stillOnScreen(get, runId, threadId, generation)) return false;
    if (get(activeRunAtom)?.id === runId) return false;
    return get(threadRunsAtom).find(run => run.id === runId)?.status === 'in_progress';
}

/**
 * The weaker guard, for work that continues after the run has settled: it
 * relaxes only the `in_progress` check, which no longer holds once the run has
 * been merged. Everything else still applies — in particular a live stream
 * taking over this id, whose own citations must not be replaced by ours.
 */
function stillOnScreen(
    get: Getter,
    runId: string,
    threadId: string,
    generation: number,
): boolean {
    if (get(threadLoadGenerationAtom) !== generation) return false;
    if (get(currentThreadIdAtom) !== threadId) return false;
    if (get(activeRunAtom)?.id === runId) return false;
    return get(threadRunsAtom).some(run => run.id === runId);
}

/**
 * Give up on a run, settling it if nothing else will pick it up.
 *
 * Called when the world has moved and we are no longer the right owner. Two
 * cases, and they want opposite things:
 *
 * - A later load bumped the generation. That load owns this thread's state and
 *   has scheduled its own wait if one is needed — leave the run alone, or we
 *   would settle it out from under the wait that replaced us.
 * - The thread on screen changed while the generation still matches, i.e. a load
 *   is in flight but has not committed. If it succeeds it replaces these runs
 *   entirely; if it fails it leaves them on screen with nobody waiting, and a
 *   run left `in_progress` there renders as though it were still generating,
 *   forever. So settle it now — a later successful load overwrites us anyway.
 */
function standDown(
    get: Getter,
    set: Setter,
    runId: string,
    generation: number,
): void {
    if (get(threadLoadGenerationAtom) !== generation) return;
    if (get(activeRunAtom)?.id === runId) return;
    if (get(threadRunsAtom).find(run => run.id === runId)?.status !== 'in_progress') return;
    logger(`recoverInterruptedRun: abandoning run ${runId}; settling it locally`, 1);
    markCanceledLocally(set, runId);
}

/** What the thread load used to do inline, kept for when waiting does not pay off. */
function markCanceledLocally(set: Setter, runId: string): void {
    set(threadRunsAtom, (runs: AgentRun[]) => runs.map(run =>
        run.id === runId
            ? {
                ...run,
                status: 'canceled' as const,
                completed_at: run.completed_at || new Date().toISOString(),
            }
            : run
    ));
}

/**
 * Fold a settled run into the thread.
 *
 * Every await happens before any write, and the writes then run in one
 * synchronous block, so Jotai batches them: the answer, its citation markers
 * and its actions appear together rather than as a torn intermediate render.
 */
async function mergeRecoveredRun(
    get: Getter,
    set: Setter,
    run: AgentRun,
    actions: AgentAction[],
    threadId: string,
    generation: number,
): Promise<void> {
    const existing = get(threadRunsAtom).find(r => r.id === run.id);

    // Keep the prompt we already have: the thread load resolved its attachment
    // stubs against the library, and the user's own message cannot have changed.
    const merged: AgentRun = {
        ...run,
        user_prompt: existing?.user_prompt ?? run.user_prompt,
    };

    const toolCallArgsById = new Map<string, string | Record<string, any> | null>();
    for (const message of merged.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'tool-call' && part.tool_call_id) {
                toolCallArgsById.set(part.tool_call_id, part.args);
            }
        }
    }
    for (const message of merged.model_messages) {
        if (message.kind !== 'request') continue;
        for (const part of message.parts) {
            if (part.part_kind !== 'tool-return') continue;
            // Re-checked per part, not just at the end: this writes into shared
            // atoms (external-reference mappings), so a thread switch partway
            // through would otherwise keep seeding the new thread with the old
            // one's results.
            if (!stillRecoverable(get, run.id, threadId, generation)) {
                standDown(get, set, run.id, generation);
                return;
            }
            await processToolReturnResults(part, set);
            await upgradeToolReturn(part, toolCallArgsById.get(part.tool_call_id));
        }
    }

    // Deliberately not running the applied-action validation the thread load
    // does: these actions are seconds old, and auto-undoing them against a
    // library that has just been mutated risks reverting real work.
    await prepareRunMetadata(actions);

    if (!stillRecoverable(get, run.id, threadId, generation)) {
        standDown(get, set, run.id, generation);
        return;
    }

    // Everything from here is synchronous, so Jotai batches it: the answer, its
    // citation markers and its actions appear in one render rather than as a
    // torn intermediate state.
    set(threadRunsAtom, (runs: AgentRun[]) => replaceRunById(runs, merged));
    applyRunMetadata(get, set, merged, actions);
}

/**
 * Load whatever a run's actions need from Zotero. Kept separate from applying
 * them so that every await happens before the first write.
 */
async function prepareRunMetadata(actions: AgentAction[]): Promise<void> {
    if (actions.length > 0) {
        await loadItemDataForAgentActions(actions);
    }
}

/**
 * Apply a run's citations and actions to the thread. Synchronous by design —
 * see the batching note in `mergeRecoveredRun`.
 *
 * Split out from the merge because the backend writes citations and actions
 * separately from the run itself, so they can arrive later and be applied alone.
 */
function applyRunMetadata(
    get: Getter,
    set: Setter,
    run: AgentRun,
    actions: AgentAction[],
): void {
    if (actions.length > 0) {
        // Same two steps the thread load performs on the actions it fetches, and
        // for the same reasons: these come from the same endpoint and need the
        // same repair and priming to render.
        //
        // Providers format tool call ids differently and pydantic-ai rewrites
        // them, so an action's `toolcall_id` may not match the one in the
        // messages. Without this the action does not group under its tool call.
        reconcileToolcallIds([run], actions);

        // Proposed items for `create_item` actions render from the external
        // reference mapping, which nothing else populates for a recovered run.
        const proposedItems = actions
            .filter(isCreateItemAgentAction)
            .map(action => action.proposed_data?.item)
            .filter(Boolean) as ExternalReference[];
        if (proposedItems.length > 0) {
            set(addExternalReferencesToMappingAtom, proposedItems);
            set(checkExternalReferencesAtom, proposedItems);
        }
    }

    const citations = (run.metadata?.citations || []).map(citation => ({
        ...citation,
        run_id: run.id,
    }));

    // Only when the run actually brought some. Citations are attached by a
    // second backend write that can land after the status flips, so an empty
    // list means "not resolved yet", not "this run has none" — clearing on it
    // would drop markers the live stream had already delivered.
    if (citations.length > 0) {
        // Ordered by the run each citation belongs to, not by when we happened
        // to receive it — the order the thread load itself produces, so the two
        // paths agree and the next full pass numbers them correctly.
        //
        // It does not renumber markers already handed out: those are sticky per
        // key until `resetCitationMarkersAtom` runs on the next thread load. So
        // a run that both started and finished inside our few seconds of waiting
        // can still leave its marker ahead of ours until then. Renumbering here
        // would relabel citations the user is currently reading, which is worse
        // than the ordering it would fix.
        const runOrder = new Map(get(threadRunsAtom).map((r, index) => [r.id, index]));
        const position = (citation: Citation) =>
            runOrder.get(citation.run_id ?? '') ?? Number.MAX_SAFE_INTEGER;
        set(citationsAtom, (prev: Citation[]) =>
            [...prev.filter(citation => citation.run_id !== run.id), ...citations]
                .sort((a, b) => position(a) - position(b))
        );
        set(processCitationsAtom);
    }

    // Added, never replaced. These are interactive after the run ends — the user
    // can apply, reject or undo one — and the follow-up look can return while
    // they are doing so, carrying the status from before their change. Our copy
    // is never the staler one: it either came from this same data or from the
    // user's own later action, so anything already here wins.
    if (actions.length > 0) {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const known = new Set(prev.map(action => action.id));
            const arrived = actions.filter(action => !known.has(action.id));
            return arrived.length > 0 ? [...prev, ...arrived] : prev;
        });
    }

    if (citations.length > 0) {
        preloadPageLabelsForCitations(citations)
            .then(labels => set(mergePageLabelsByAttachmentIdAtom, labels))
            .catch(err => logger(`recoverInterruptedRun: page label preload failed: ${err}`, 1));
    }
}

/**
 * Look again for citations and note proposals the backend writes after a run's
 * status.
 *
 * Called once the run's text is already on screen, so nothing here is urgent
 * and nothing is shown as pending — it either finds metadata and adds it, or
 * finds none and leaves the turn exactly as it is. Failures are logged and
 * dropped: the answer is already saved and rendered.
 */
async function waitForLateMetadata(
    get: Getter,
    set: Setter,
    runId: string,
    threadId: string,
    generation: number,
    already: { citations: boolean; actions: boolean },
): Promise<void> {
    // The backend writes citations first and actions second, so one can be
    // visible while the other is still landing. Tracked separately: applying
    // what arrived and stopping would leave the other missing until reload.
    // Seeded with what the settled fetch already carried, so a channel that is
    // already applied is not written again on the first look.
    let haveCitations = already.citations;
    let haveActions = already.actions;

    for (const delay of LATE_METADATA_BACKOFF_MS) {
        await sleep(delay);
        if (!stillOnScreen(get, runId, threadId, generation)) return;

        let fetched;
        try {
            fetched = await withTimeout(
                agentRunService.getRun(runId, true),
                REFETCH_TIMEOUT_MS,
                `metadata follow-up for run ${runId}`,
            );
        } catch (error) {
            logger(`recoverInterruptedRun: metadata follow-up for ${runId} failed: ${error}`, 1);
            continue;
        }

        const actions = fetched.agent_actions ?? [];
        const citationsArrived = (fetched.run.metadata?.citations || []).length > 0;
        const actionsArrived = actions.length > 0;

        // Nothing new since the last look. Either is worth applying on its own:
        // an answer can propose a note without citing anything.
        if (citationsArrived === haveCitations && actionsArrived === haveActions) {
            continue;
        }

        await prepareRunMetadata(actions);
        if (!stillOnScreen(get, runId, threadId, generation)) return;

        logger(`recoverInterruptedRun: metadata for run ${runId} landed after its status`, 1);
        // Re-applying a channel that already landed is harmless: citations
        // replace this run's slice, and actions are merged by id rather than
        // replaced, so a status the user changed meanwhile survives.
        applyRunMetadata(get, set, fetched.run, actions);
        haveCitations = citationsArrived;
        haveActions = actionsArrived;

        // Both channels in hand; nothing else is coming.
        if (haveCitations && haveActions) return;
    }
}

/**
 * Wait for one interrupted run to settle, then merge it into the open thread.
 *
 * Fire-and-forget: never awaited by the thread load, and it resolves silently
 * whenever the thread it belongs to is no longer the one on screen.
 */
export const recoverInterruptedRunAtom = atom(
    null,
    async (get, set, { runId, threadId }: { runId: string; threadId: string }): Promise<void> => {
        if (get(recoveringRunIdsAtom).has(runId)) return;
        // Captured before the first await. Everything after checks it, so a wait
        // belonging to a superseded load can neither act nor clean up after the
        // one that replaced it.
        const generation = get(threadLoadGenerationAtom);
        set(recoveringRunIdsAtom, prev => new Set(prev).add(runId));

        try {
            for (const range of REFETCH_BACKOFF_MS) {
                await sleep(jitteredDelay(range));
                if (!stillRecoverable(get, runId, threadId, generation)) {
                    standDown(get, set, runId, generation);
                    return;
                }

                let fetched;
                try {
                    fetched = await withTimeout(
                        agentRunService.getRun(runId, true),
                        REFETCH_TIMEOUT_MS,
                        `refetch of run ${runId}`,
                    );
                } catch (error) {
                    if (error instanceof ApiError && error.status === 404) {
                        // No such run to wait for.
                        break;
                    }
                    logger(`recoverInterruptedRun: refetch of ${runId} failed: ${error}`, 1);
                    continue;
                }

                if (!stillRecoverable(get, runId, threadId, generation)) {
                    standDown(get, set, runId, generation);
                    return;
                }
                if (fetched.run.status === 'in_progress') continue;

                logger(
                    `recoverInterruptedRun: run ${runId} settled as ${fetched.run.status}` +
                    ` (${fetched.run.error?.reason_code ?? 'no reason code'})`,
                    1,
                );
                try {
                    await mergeRecoveredRun(get, set, fetched.run, fetched.agent_actions ?? [], threadId, generation);
                    // The answer is on screen. Its citations and note proposals
                    // are written afterwards, in that order, so look again
                    // unless both are already here — otherwise a reopened
                    // interrupted turn keeps raw citation markup, or loses a
                    // note proposal, until the user reloads the thread.
                    //
                    // "Absent" cannot be told from "still coming": a run with
                    // citations and no notes legitimately has no actions, and
                    // nothing in the payload says which. So the ambiguous case
                    // is polled rather than assumed complete. It costs a couple
                    // of requests on a run that was interrupted *and* reopened
                    // during its save, which is rare.
                    const metadataIncomplete =
                        (fetched.run.metadata?.citations || []).length === 0
                        || (fetched.agent_actions ?? []).length === 0;
                    if (metadataIncomplete) {
                        await waitForLateMetadata(get, set, runId, threadId, generation, {
                            citations: (fetched.run.metadata?.citations || []).length > 0,
                            actions: (fetched.agent_actions ?? []).length > 0,
                        });
                    }
                    return;
                } catch (error) {
                    // The run did settle; we just could not render it. Fall
                    // through to the local cancel rather than leaving it
                    // `in_progress`, which reads as "Generating" forever once
                    // the recovery marker is gone.
                    logger(`recoverInterruptedRun: merging run ${runId} failed: ${error}`, 1);
                    break;
                }
            }

            // Out of attempts. The backend has no reaper, so a row can stay
            // `in_progress` indefinitely; settle it locally rather than spin.
            if (stillRecoverable(get, runId, threadId, generation)) {
                logger(`recoverInterruptedRun: run ${runId} never settled; marking canceled locally`, 1);
                markCanceledLocally(set, runId);
            }
        } finally {
            // Only our own marker. A later load may have re-added this same run
            // id for its own wait, and clearing that one would both hide its
            // spinner and let a third wait start alongside it.
            if (get(threadLoadGenerationAtom) === generation) {
                set(recoveringRunIdsAtom, prev => {
                    const next = new Set(prev);
                    next.delete(runId);
                    return next;
                });
            }
        }
    }
);
