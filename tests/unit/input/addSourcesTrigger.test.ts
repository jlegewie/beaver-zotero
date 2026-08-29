import { describe, expect, it } from 'vitest';
import { matchSourcesTrigger, queryForOpenTrigger } from '@beaver/agent-ui/composer/useAddSourcesMenu';

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

    // A prompt-edit overlay seeds the editor with the sent message and focuses
    // with the caret at its end, so the first keystroke of an edit follows a
    // word character the user did not type.
    it('opens on an @ appended to the untouched baseline', () => {
        expect(matchSourcesTrigger('summarize this paper@', 'summarize this paper'))
            .toEqual({ prefix: 'summarize this paper' });
    });

    it('applies the word guard again once the user has typed', () => {
        expect(matchSourcesTrigger('summarize this paper now@', 'summarize this paper')).toBeNull();
    });

    it('still opens after a space typed past the baseline', () => {
        expect(matchSourcesTrigger('summarize this paper @', 'summarize this paper'))
            .toEqual({ prefix: 'summarize this paper ' });
    });

    it('leaves an email typed into a baselined editor alone', () => {
        expect(matchSourcesTrigger('write to joscha@', 'summarize this paper')).toBeNull();
    });
});

describe('queryForOpenTrigger', () => {
    const trigger = { prefix: 'summarize ' };

    it('reads the query as everything after the @', () => {
        expect(queryForOpenTrigger('summarize @smith', trigger)).toBe('smith');
    });

    it('keeps spaces inside the query', () => {
        expect(queryForOpenTrigger('summarize @smith 2020', trigger)).toBe('smith 2020');
    });

    it('is empty right after the @ is typed', () => {
        expect(queryForOpenTrigger('summarize @', trigger)).toBe('');
    });

    it('closes the menu when the @ is deleted', () => {
        expect(queryForOpenTrigger('summarize ', trigger)).toBeNull();
    });

    it('closes the menu when the edit lands ahead of the trigger', () => {
        expect(queryForOpenTrigger('please summarize @smith', trigger)).toBeNull();
    });
});
