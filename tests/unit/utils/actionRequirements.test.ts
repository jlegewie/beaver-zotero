import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ARGUMENT_REQUIRED_HINT,
    getActionRequirementBlock,
    hasTextBesidesPills,
    type ActionRequirementInput,
} from '../../../react/utils/actionRequirements';
import type { SlashCommandDescriptor } from '@beaver/agent-ui/composer/slashCommands';
import type { ActionTargetType } from '@beaver/agent-core/types/actions';

const annotate = { id: 'builtin-annotate', argumentRequired: true, argumentRequiredHint: 'Describe what to highlight' };
const summarize = { id: 'builtin-summarize' };
const custom = { id: 'custom-1', argumentRequired: true };

const pill = (actionId: string, commandName: string, targetType?: ActionTargetType): SlashCommandDescriptor =>
    ({ actionId, commandName, targetType });

function check(overrides: Partial<ActionRequirementInput>) {
    return getActionRequirementBlock({
        content: '',
        pills: [],
        actions: [annotate, summarize, custom],
        ...overrides,
    });
}

describe('getActionRequirementBlock', () => {
    const blocked = { hint: 'Describe what to highlight after /annotate' };

    it('blocks a command that needs text when nothing follows it', () => {
        expect(check({ content: '/annotate ', pills: [pill(annotate.id, 'annotate', 'global')] })).toEqual(blocked);
    });

    it('blocks the same way whether or not the ghost text shows', () => {
        const withPlaceholder = { ...pill(annotate.id, 'annotate', 'global'), argumentHint: 'What should I highlight?' };
        expect(check({ content: '/annotate ', pills: [withPlaceholder] })).toEqual(blocked);
        expect(check({ content: '/annotate\n', pills: [withPlaceholder] })).toEqual(blocked);
    });

    it('passes once there is text, before or after the command', () => {
        const pills = [pill(annotate.id, 'annotate', 'global')];
        expect(check({ content: '/annotate the methods', pills })).toBeNull();
        expect(check({ content: 'in this paper /annotate', pills })).toBeNull();
    });

    it('does not count another command as text, and names the command that needs it', () => {
        const pills = [pill(summarize.id, 'summarize'), pill(annotate.id, 'annotate', 'global')];
        expect(check({ content: '/summarize /annotate ', pills })).toEqual(blocked);
        expect(check({ content: '/annotate /summarize ', pills: [...pills].reverse() })).toEqual(blocked);
    });

    it('names the command the pill shows, so a renamed command reads right', () => {
        expect(check({ content: '/highlight', pills: [pill(annotate.id, 'highlight', 'global')] }))
            .toEqual({ hint: 'Describe what to highlight after /highlight' });
    });

    it('falls back to a generic lead-in when the action names none', () => {
        expect(check({ content: '/mine', pills: [pill(custom.id, 'mine', 'global')] }))
            .toEqual({ hint: `${DEFAULT_ARGUMENT_REQUIRED_HINT} after /mine` });
    });

    it('does not block a command whose argument is optional, whatever its targets', () => {
        expect(check({ content: '/summarize ', pills: [pill(summarize.id, 'summarize')] })).toBeNull();
        expect(check({ content: '/summarize ', pills: [pill(summarize.id, 'summarize', 'attachment')] })).toBeNull();
    });

    it('skips pills whose action no longer exists', () => {
        const missing = { ...pill('custom-deleted', 'gone'), missing: true };
        expect(check({ content: '/gone', pills: [missing] })).toBeNull();
        expect(check({ content: '/gone', pills: [pill('custom-deleted', 'gone')] })).toBeNull();
    });

    it('does not block a message without pills', () => {
        expect(check({ content: '' })).toBeNull();
    });
});

describe('hasTextBesidesPills', () => {
    it('ignores whitespace and pill tokens', () => {
        const pills = [pill(annotate.id, 'annotate')];
        expect(hasTextBesidesPills(' /annotate \n ', pills)).toBe(false);
        expect(hasTextBesidesPills('/annotate x', pills)).toBe(true);
    });

    it('counts a /token that is not a pill as text', () => {
        expect(hasTextBesidesPills('/annotate', [])).toBe(true);
    });
});
