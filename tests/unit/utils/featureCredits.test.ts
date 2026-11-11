import { describe, expect, it } from 'vitest';
import type { FeatureCreditTask } from '@beaver/agent-core/types/profile';
import {
    COMPLETION_GRACE_MS,
    FeatureCreditCompletionTracker,
    attachStep,
    canRunFeatureTasks,
    featureTaskModelNote,
    topicStatus,
    type AttachmentSummary,
    type ModelAccess,
} from '../../../react/utils/featureCredits';
import { FEATURE_CREDIT_TASKS, examplesForLibrary, getFeatureCreditTask } from '../../../react/constants/featureCreditTasks';

const none: AttachmentSummary = { papers: [], collections: [] };
const papers = (...names: string[]): AttachmentSummary => ({ papers: names, collections: [] });
const collection = (name: string, itemCount: number | null): AttachmentSummary => ({ papers: [], collections: [{ name, itemCount }] });

describe('setup card step 1', () => {
    it('asks for a paper when nothing is attached', () => {
        expect(attachStep({ kind: 'paper' }, none)).toEqual({
            done: false,
            lead: 'Attach a paper:',
            text: 'type @ to search your library, drag it in from Zotero, or open its PDF.',
        });
    });

    it('marks the step optional for notes', () => {
        expect(attachStep({ kind: 'paper', optional: true }, none)?.lead).toBe('Optional: attach a paper to write about:');
    });

    it('names a single attached paper', () => {
        expect(attachStep({ kind: 'paper' }, papers('Smith 2020'))).toEqual({
            done: true,
            lead: 'Smith 2020 is attached.',
            text: 'Add other papers with @ or drag and drop.',
        });
    });

    it('counts several attached papers', () => {
        expect(attachStep({ kind: 'paper' }, papers('A', 'B', 'C'))).toMatchObject({
            done: true,
            lead: '3 papers are attached.',
            text: 'Add more with @ or drag and drop.',
        });
    });

    it('asks for a collection or papers for organizing, and names an attached collection', () => {
        expect(attachStep({ kind: 'collection' }, none)?.lead).toBe('Attach a collection or papers:');
        expect(attachStep({ kind: 'collection' }, collection('Neighborhood effects', 14))?.lead)
            .toBe('The Neighborhood effects collection (14 papers) is attached.');
    });

    it('names a collection and papers attached together', () => {
        expect(attachStep({ kind: 'collection' }, { papers: ['A', 'B'], collections: [{ name: 'X', itemCount: 1 }] })?.lead)
            .toBe('The X collection (1 paper) and 2 papers are attached.');
        expect(attachStep({ kind: 'collection' }, { papers: [], collections: [{ name: 'A', itemCount: 2 }, { name: 'B', itemCount: null }] })?.lead)
            .toBe('The A collection (2 papers) and the B collection are attached.');
    });

    it('has no attach step for topic tasks', () => {
        expect(attachStep({ kind: 'topic' }, papers('A'))).toBeNull();
    });
});

describe('research table status line', () => {
    it('shows nothing when nothing is attached', () => {
        expect(topicStatus(none)).toBeNull();
    });

    it('follows the 10-20 paper rule', () => {
        expect(topicStatus(collection('Big', 300))?.text).toBe('Beaver will pick the most relevant papers from it. Remove it to search your whole library.');
        expect(topicStatus(collection('Mid', 14))?.text).toBe('Beaver will use these papers.');
        expect(topicStatus(papers('A', 'B'))?.text).toBe('Beaver will add related papers from your library.');
    });

    it('treats a collection of unknown size as large', () => {
        expect(topicStatus(collection('Unknown', null))?.text).toContain('pick the most relevant');
    });
});

describe('task registry', () => {
    it('has the four v1 tasks with unique keys and actions', () => {
        expect(FEATURE_CREDIT_TASKS.map((task) => task.key)).toEqual(['annotate', 'note', 'organize', 'research_table']);
        expect(new Set(FEATURE_CREDIT_TASKS.map((task) => task.actionId)).size).toBe(4);
        expect(getFeatureCreditTask('unknown')).toBeUndefined();
    });

    it('fits the organize examples to how the library is organized', () => {
        const organize = getFeatureCreditTask('organize')!;
        const texts = (shape: Parameters<typeof examplesForLibrary>[1]) => examplesForLibrary(organize, shape).map((e) => e.text);
        expect(texts({ collectionCount: 0, usesTags: false })).toEqual(['fill in missing abstracts and DOIs']);
        expect(texts({ collectionCount: 3, usesTags: true })).toHaveLength(3);
        expect(texts(null)).toEqual(['fill in missing abstracts and DOIs']);
    });
});

describe('completion tracker', () => {
    const task = (key: string, threadId: string | null, done = true): FeatureCreditTask => ({
        key,
        credits: 5,
        completed_at: done ? '2026-11-20T10:00:00Z' : null,
        source: done ? { thread_id: threadId, run_id: 'r' } : null,
    });
    const make = () => {
        let now = 0;
        const tracker = new FeatureCreditCompletionTracker((key) => key !== 'unknown', () => now);
        return { tracker, advance: (ms: number) => { now += ms; } };
    };

    it('never shows a card for tasks already done when the window starts', () => {
        const { tracker } = make();
        tracker.setOpenThread('t1');
        tracker.updateTasks([task('annotate', 't1')], 1);
        expect(tracker.takeReady(true)).toEqual([]);
    });

    it('shows a card for a task earned in the open chat, once, when idle', () => {
        const { tracker } = make();
        tracker.setOpenThread('t1');
        tracker.updateTasks([task('annotate', null, false)], 1);
        tracker.updateTasks([task('annotate', 't1')], 1);
        expect(tracker.takeReady(false)).toEqual([]);
        expect(tracker.takeReady(true).map((c) => c.task.key)).toEqual(['annotate']);
        tracker.updateTasks([task('annotate', 't1')], 1);
        expect(tracker.takeReady(true)).toEqual([]);
    });

    it('shows no card for a task earned in another chat', () => {
        const { tracker } = make();
        tracker.setOpenThread('t2');
        tracker.updateTasks([task('note', null, false)], 1);
        tracker.updateTasks([task('note', 't1')], 1);
        expect(tracker.takeReady(true)).toEqual([]);
    });

    it('shows the card for a chat left within the grace period, not after', () => {
        const { tracker, advance } = make();
        tracker.setOpenThread('t1');
        tracker.updateTasks([task('annotate', null, false), task('note', null, false)], 1);
        tracker.setOpenThread(null);
        advance(COMPLETION_GRACE_MS - 1);
        tracker.updateTasks([task('annotate', 't1'), task('note', null, false)], 1);
        expect(tracker.takeReady(true).map((c) => c.task.key)).toEqual(['annotate']);
        advance(1);
        tracker.updateTasks([task('annotate', 't1'), task('note', 't1')], 1);
        expect(tracker.takeReady(true)).toEqual([]);
    });

    it('ignores unknown task keys and tasks without a chat', () => {
        const { tracker } = make();
        tracker.setOpenThread('t1');
        tracker.updateTasks([task('unknown', null, false), task('research_table', null, false)], 1);
        tracker.updateTasks([task('unknown', 't1'), task('research_table', null)], 1);
        expect(tracker.takeReady(true)).toEqual([]);
    });

    it('shows a card again for a task earned after its grant was withdrawn', () => {
        const { tracker } = make();
        tracker.setOpenThread('t1');
        tracker.updateTasks([task('annotate', 'old')], 1);
        tracker.updateTasks([task('annotate', null, false)], 1);
        tracker.updateTasks([task('annotate', 't1')], 1);
        expect(tracker.takeReady(true).map((c) => c.task.key)).toEqual(['annotate']);
    });

    it('starts over when the account changes', () => {
        const { tracker } = make();
        tracker.setOpenThread('t1');
        tracker.updateTasks([task('annotate', null, false)], 1);
        tracker.updateTasks(null, 2);
        tracker.updateTasks([task('annotate', 't1')], 2);
        expect(tracker.takeReady(true)).toEqual([]);
    });
});

describe('model and credits', () => {
    const access = (overrides: Partial<ModelAccess>): ModelAccess => ({
        onBeaverModel: true,
        hasBeaverCredits: true,
        hasOwnModel: false,
        ...overrides,
    });

    it('says nothing when the Beaver model can run the task', () => {
        for (const key of ['annotate', 'note', 'organize', 'research_table']) {
            expect(featureTaskModelNote(key, access({}))).toBeNull();
        }
    });

    it('recommends the Beaver model to someone on their own model, and requires it for tables', () => {
        const own = access({ onBeaverModel: false, hasOwnModel: true });
        expect(featureTaskModelNote('annotate', own)).toEqual({
            text: 'These tasks work best with the Beaver model.',
            offerBeaverModel: true,
            required: false,
        });
        expect(featureTaskModelNote('research_table', own)).toMatchObject({ offerBeaverModel: true, required: true });
    });

    it('without Beaver credits, points to the own model and says tables cannot run', () => {
        const ownSelected = access({ onBeaverModel: false, hasBeaverCredits: false, hasOwnModel: true });
        expect(featureTaskModelNote('note', ownSelected)).toBeNull();
        expect(featureTaskModelNote('research_table', ownSelected)).toMatchObject({ offerBeaverModel: false, required: true });
        const beaverSelected = access({ hasBeaverCredits: false, hasOwnModel: true });
        expect(featureTaskModelNote('organize', beaverSelected)?.text).toContain('Choose your own model');
        // Reached from Plan & Usage with no way to run a task at all.
        const neither = access({ hasBeaverCredits: false, hasOwnModel: false });
        expect(featureTaskModelNote('organize', neither)?.text).toBe("You don't have enough Beaver credits left. Add credits or your own API key to try this.");
    });

    it('can run tasks with Beaver credits or a model of their own, not with neither', () => {
        expect(canRunFeatureTasks(access({}))).toBe(true);
        expect(canRunFeatureTasks(access({ hasBeaverCredits: false, hasOwnModel: true }))).toBe(true);
        expect(canRunFeatureTasks(access({ hasBeaverCredits: false }))).toBe(false);
    });
});

describe('setup card examples', () => {
    it('shows topic examples for tables as text, not as links that fill the input', () => {
        const table = getFeatureCreditTask('research_table')!;
        expect(table.examples.length).toBeGreaterThan(0);
        expect(table.examples.every((example) => example.illustration)).toBe(true);
    });

    it('keeps one-click examples only where they fit any library', () => {
        const linked = FEATURE_CREDIT_TASKS
            .filter((task) => task.key !== 'research_table')
            .flatMap((task) => task.examples.map((example) => example.text));
        expect(linked).not.toContain('what my library says about measurement error');
        expect(linked).not.toContain('every definition of social capital');
    });
});
