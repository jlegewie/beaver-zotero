import { describe, expect, it } from 'vitest';
import { matchMenuTrigger, matchSourcesTrigger, queryForOpenTrigger } from '@beaver/agent-ui/composer/useAddSourcesMenu';

describe('matchSourcesTrigger', () => {
    it.each([
        ['sdfsdf@', 7, false],
        ['sdfsdf @', 8, true],
        ['sdfsdf\n@', 8, true],
        ['@sdfsdf', 1, true],
        ['sdfsdf@DSdsd', 7, false],
    ])('%j with the caret after the @ opens the menu: %s', (value, caret, opens) => {
        expect(matchSourcesTrigger(value as string, '', caret as number) !== null).toBe(opens);
    });

    it('applies the same rule to the / actions trigger', () => {
        expect(matchMenuTrigger('/', '/sdfsdf', '', 1)).toEqual({ prefix: '', suffix: 'sdfsdf' });
        expect(matchMenuTrigger('/', 'and/or', '', 4)).toBeNull();
        expect(matchMenuTrigger('/', 'first\n/', '', 7)).toEqual({ prefix: 'first\n', suffix: '' });
    });

    it('opens on an @ at the very start of the composer', () => {
        expect(matchSourcesTrigger('@')).toEqual({ prefix: '', suffix: '' });
    });

    it('opens on an @ that starts a word', () => {
        expect(matchSourcesTrigger('summarize @')).toEqual({ prefix: 'summarize ', suffix: '' });
    });

    it('opens on an @ at the start of a new line', () => {
        expect(matchSourcesTrigger('summarize\n@')).toEqual({ prefix: 'summarize\n', suffix: '' });
    });

    it('leaves an @ inside a word alone, so email addresses stay plain text', () => {
        expect(matchSourcesTrigger('joscha@')).toBeNull();
    });

    it('ignores an @ that is not the last character typed', () => {
        expect(matchSourcesTrigger('@smith')).toBeNull();
    });

    it('opens on an @ typed at the end of a line with more lines after it', () => {
        expect(matchSourcesTrigger('summarize @\nthen compare', '', 11))
            .toEqual({ prefix: 'summarize ', suffix: '\nthen compare' });
    });

    it('opens on an @ typed in front of existing text', () => {
        expect(matchSourcesTrigger('@sdfsdf', '', 1)).toEqual({ prefix: '', suffix: 'sdfsdf' });
    });

    it('opens on an @ typed after a space in the middle of a line', () => {
        expect(matchSourcesTrigger('summarize @ this', '', 11))
            .toEqual({ prefix: 'summarize ', suffix: ' this' });
    });

    it('leaves an @ typed inside a word alone, whatever follows it', () => {
        expect(matchSourcesTrigger('sdfsdf@DSdsd', '', 7)).toBeNull();
    });

    it('ignores an @ that is not the character before the caret', () => {
        expect(matchSourcesTrigger('summarize @\nthen', '', 17)).toBeNull();
    });

    // A seeded editor's first keystroke may land anywhere in the seed.
    it('opens on an @ inserted anywhere into the untouched baseline', () => {
        expect(matchSourcesTrigger('summarize@ this', 'summarize this', 10))
            .toEqual({ prefix: 'summarize', suffix: ' this' });
    });

    it('ignores text with no @ at all', () => {
        expect(matchSourcesTrigger('summarize this')).toBeNull();
    });

    // A prompt-edit overlay seeds the editor with the sent message and focuses
    // with the caret at its end, so the first keystroke of an edit follows a
    // word character the user did not type.
    it('opens on an @ appended to the untouched baseline', () => {
        expect(matchSourcesTrigger('summarize this paper@', 'summarize this paper'))
            .toEqual({ prefix: 'summarize this paper', suffix: '' });
    });

    it('applies the word guard again once the user has typed', () => {
        expect(matchSourcesTrigger('summarize this paper now@', 'summarize this paper')).toBeNull();
    });

    it('still opens after a space typed past the baseline', () => {
        expect(matchSourcesTrigger('summarize this paper @', 'summarize this paper'))
            .toEqual({ prefix: 'summarize this paper ', suffix: '' });
    });

    it('leaves an email typed into a baselined editor alone', () => {
        expect(matchSourcesTrigger('write to joscha@', 'summarize this paper')).toBeNull();
    });
});

describe('queryForOpenTrigger', () => {
    const trigger = { prefix: 'summarize ', suffix: '' };

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

    describe('with lines after the @', () => {
        const midTrigger = { prefix: 'summarize ', suffix: '\nthen compare' };

        it('reads the query between the @ and the following lines', () => {
            expect(queryForOpenTrigger('summarize @smith\nthen compare', midTrigger)).toBe('smith');
        });

        it('is empty right after the @ is typed', () => {
            expect(queryForOpenTrigger('summarize @\nthen compare', midTrigger)).toBe('');
        });

        it('closes the menu when the following lines are edited', () => {
            expect(queryForOpenTrigger('summarize @smith\nthen contrast', midTrigger)).toBeNull();
        });

        it('closes the menu when the @ is deleted', () => {
            expect(queryForOpenTrigger('summarize \nthen compare', midTrigger)).toBeNull();
        });
    });
});
