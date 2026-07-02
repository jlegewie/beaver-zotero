import { describe, it, expect } from 'vitest';
import {
    toSlashToken,
    splitContentBySlashTokens,
    hasSlashToken,
    filterPromptActionsForContent,
} from '../../../react/utils/slashCommands';
import type { PromptAction } from '../../../react/agents/types';

const action = (command: string, title?: string): PromptAction => ({
    command,
    action_id: `id-${command}`,
    title: title ?? command,
    prompt: `Prompt for ${command}`,
});

describe('toSlashToken', () => {
    it('lowercases and hyphenates non-alphanumerics', () => {
        expect(toSlashToken('Summarize Paper')).toBe('summarize-paper');
        expect(toSlashToken('  Find & Replace!  ')).toBe('find-replace');
    });

    it('falls back to "action" for empty results', () => {
        expect(toSlashToken('!!!')).toBe('action');
        expect(toSlashToken('')).toBe('action');
    });
});

describe('splitContentBySlashTokens', () => {
    it('splits token at start of content', () => {
        const segments = splitContentBySlashTokens('/summarize and more', [action('summarize')]);
        expect(segments).toHaveLength(2);
        expect(segments[0]).toMatchObject({ text: '/summarize' });
        expect(segments[0].action?.command).toBe('summarize');
        expect(segments[1]).toEqual({ text: ' and more' });
    });

    it('matches token at end of string', () => {
        const segments = splitContentBySlashTokens('please /summarize', [action('summarize')]);
        expect(segments.map(s => s.text)).toEqual(['please ', '/summarize']);
        expect(segments[1].action).toBeDefined();
    });

    it('preserves the leading boundary char in the text segment', () => {
        const segments = splitContentBySlashTokens('a (/summarize) b', [action('summarize')]);
        expect(segments.map(s => s.text)).toEqual(['a (', '/summarize', ') b']);
        expect(segments[1].action?.command).toBe('summarize');
    });

    it('does not match a shorter command inside a longer token', () => {
        const segments = splitContentBySlashTokens('/summarize-paper now', [
            action('sum'),
            action('summarize-paper'),
        ]);
        expect(segments[0].action?.command).toBe('summarize-paper');
        expect(segments.some(s => s.action?.command === 'sum')).toBe(false);
    });

    it('does not match inside URLs or paths', () => {
        const segments = splitContentBySlashTokens(
            'see https://x.test/summarize for details',
            [action('summarize')],
        );
        expect(segments).toHaveLength(1);
        expect(segments[0].action).toBeUndefined();
    });

    it('handles multiple and repeated tokens', () => {
        const segments = splitContentBySlashTokens('/a then /b then /a', [action('a'), action('b')]);
        const tokens = segments.filter(s => s.action);
        expect(tokens.map(s => s.text)).toEqual(['/a', '/b', '/a']);
    });

    it('returns whole content as one segment when no actions', () => {
        expect(splitContentBySlashTokens('hello', [])).toEqual([{ text: 'hello' }]);
    });

    it('escapes regex metacharacters in commands', () => {
        // toSlashToken normally prevents these, but the tokenizer must not throw
        const segments = splitContentBySlashTokens('/a.b c', [action('a.b')]);
        expect(segments[0].action?.command).toBe('a.b');
        // The "." must not act as a wildcard
        const noMatch = splitContentBySlashTokens('/aXb c', [action('a.b')]);
        expect(noMatch.every(s => !s.action)).toBe(true);
    });
});

describe('hasSlashToken', () => {
    it('detects bounded tokens only', () => {
        expect(hasSlashToken('/summarize', 'summarize')).toBe(true);
        expect(hasSlashToken('do /summarize now', 'summarize')).toBe(true);
        expect(hasSlashToken('/summarize-paper', 'summarize')).toBe(false);
        expect(hasSlashToken('https://x.test/summarize', 'summarize')).toBe(false);
    });
});

describe('filterPromptActionsForContent', () => {
    it('keeps actions whose token is still present', () => {
        const actions = [action('a'), action('b')];
        const kept = filterPromptActionsForContent(actions, '/a remains');
        expect(kept?.map(a => a.command)).toEqual(['a']);
    });

    it('returns undefined when nothing remains', () => {
        expect(filterPromptActionsForContent([action('a')], 'no tokens here')).toBeUndefined();
        expect(filterPromptActionsForContent([], 'x')).toBeUndefined();
        expect(filterPromptActionsForContent(undefined, 'x')).toBeUndefined();
    });
});
