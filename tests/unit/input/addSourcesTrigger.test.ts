import { describe, expect, it } from 'vitest';
import { matchSourcesTrigger, queryForOpenTrigger } from '../../../react/hooks/useAddSourcesMenu';

describe('matchSourcesTrigger', () => {
    it('opens on an @ at the very start of the composer', () => {
        expect(matchSourcesTrigger('@')).toEqual({ prefix: '' });
    });

    it('opens on an @ that starts a word', () => {
        expect(matchSourcesTrigger('summarize @')).toEqual({ prefix: 'summarize ' });
    });

    it('opens on an @ at the start of a new line', () => {
        expect(matchSourcesTrigger('summarize\n@')).toEqual({ prefix: 'summarize\n' });
    });

    it('leaves an @ inside a word alone, so email addresses stay plain text', () => {
        expect(matchSourcesTrigger('joscha@')).toBeNull();
    });

    it('ignores an @ that is not the last character typed', () => {
        expect(matchSourcesTrigger('@smith')).toBeNull();
    });

    it('ignores text with no @ at all', () => {
        expect(matchSourcesTrigger('summarize this')).toBeNull();
    });
});

describe('queryForOpenTrigger', () => {
    const typed = { prefix: 'summarize ', hasMarker: true };
    const button = { prefix: 'summarize ', hasMarker: false };

    it('reads the query as everything after the @', () => {
        expect(queryForOpenTrigger('summarize @smith', typed)).toBe('smith');
    });

    it('keeps spaces inside the query', () => {
        expect(queryForOpenTrigger('summarize @smith 2020', typed)).toBe('smith 2020');
    });

    it('is empty right after the @ is typed', () => {
        expect(queryForOpenTrigger('summarize @', typed)).toBe('');
    });

    it('closes the menu when the @ is deleted', () => {
        expect(queryForOpenTrigger('summarize ', typed)).toBeNull();
    });

    it('closes the menu when the edit lands ahead of the trigger', () => {
        expect(queryForOpenTrigger('please summarize @smith', typed)).toBeNull();
    });

    it('reads the query straight off the content for a button-opened menu', () => {
        expect(queryForOpenTrigger('summarize smith', button)).toBe('smith');
        expect(queryForOpenTrigger('summariz', button)).toBeNull();
    });
});
