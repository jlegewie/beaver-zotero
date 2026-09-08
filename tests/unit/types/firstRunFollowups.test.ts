import { describe, it, expect } from 'vitest';
import {
    FIRST_RUN_FOLLOWUPS,
    WHERE_TO_START_FOLLOWUPS,
    getFollowupsForCardKind,
    getFollowupsForWhereToStart,
    getWhereToStartCardKind,
    renderFollowup,
} from '../../../react/types/firstRunFollowups';

const ids = (list: { id: string }[]) => list.map((f) => f.id);

describe('firstRunFollowups', () => {
    describe('getFollowupsForWhereToStart', () => {
        it('returns launcher follow-ups keyed by built-in action id', () => {
            expect(ids(getFollowupsForWhereToStart('builtin-start-project')))
                .toEqual(['project_overview_note', 'organize_into_sub_collections', 'discover_more_external']);
            expect(ids(getFollowupsForWhereToStart('builtin-color-code')))
                .toEqual(['summarize_in_note', 'related_in_library', 'find_recent_external']);
            expect(ids(getFollowupsForWhereToStart('builtin-tidy-up')))
                .toEqual(['continue_next_batch', 'design_tag_vocabulary']);
            expect(ids(getFollowupsForWhereToStart('builtin-whats-new')))
                .toEqual(['save_top_to_collection', 'compare_to_library']);
        });

        it('returns an empty list for an unknown action id', () => {
            expect(getFollowupsForWhereToStart('nope')).toEqual([]);
        });
    });

    describe('getWhereToStartCardKind', () => {
        it('maps each launcher action to a representative card kind', () => {
            expect(getWhereToStartCardKind('builtin-start-project')).toBe('literature_review');
            expect(getWhereToStartCardKind('builtin-color-code')).toBe('reading_assistant');
            expect(getWhereToStartCardKind('builtin-tidy-up')).toBe('organize_library');
            expect(getWhereToStartCardKind('builtin-whats-new')).toBe('discover_research');
        });

        it('falls back for an unknown action id', () => {
            expect(getWhereToStartCardKind('nope')).toBe('discover_research');
        });
    });

    describe('shared follow-up constants', () => {
        it('color-code launcher reuses the reading-assistant related/online follow-ups', () => {
            // Same object identity confirms the single-source-of-truth refactor.
            const launcher = getFollowupsForWhereToStart('builtin-color-code');
            const reading = FIRST_RUN_FOLLOWUPS.reading_assistant;
            expect(launcher.find((f) => f.id === 'related_in_library'))
                .toBe(reading.find((f) => f.id === 'related_in_library'));
            expect(launcher.find((f) => f.id === 'find_recent_external'))
                .toBe(reading.find((f) => f.id === 'find_recent_external'));
        });

        it('discover launcher reuses the discover_research follow-ups', () => {
            const launcher = getFollowupsForWhereToStart('builtin-whats-new');
            expect(launcher).toEqual(FIRST_RUN_FOLLOWUPS.discover_research);
        });

        it('preserves existing card-kind follow-ups after the refactor', () => {
            expect(ids(getFollowupsForCardKind('reading_assistant', false)))
                .toEqual(['skim_with_highlights', 'related_in_library', 'find_recent_external']);
            expect(ids(getFollowupsForCardKind('discover_research', false)))
                .toEqual(['save_top_to_collection', 'compare_to_library']);
        });
    });

    describe('renderFollowup with launcher topics', () => {
        const discoverMore = () =>
            WHERE_TO_START_FOLLOWUPS['builtin-start-project'].find(
                (f) => f.id === 'discover_more_external',
            )!;

        it('uses the topic-anchored variant when a topic is present', () => {
            const { title, prompt } = renderFollowup(discoverMore(), 'social capital');
            expect(title).toBe('Find more recent research on social capital');
            expect(prompt).toContain('social capital');
            expect(title).not.toContain('{topic}');
            expect(prompt).not.toContain('{topic}');
        });

        it('falls back to the base copy when no topic is present', () => {
            const { title } = renderFollowup(discoverMore(), null);
            expect(title).toBe('Find more recent research on this topic');
        });
    });
});
