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
const colorCode = { id: 'builtin-color-code' };
const sort = { id: 'builtin-sort-into-collections' };
const gaps = { id: 'builtin-collection-gaps' };
const custom = { id: 'custom-1', argumentRequired: true };

const pill = (actionId: string, commandName: string, targetType?: ActionTargetType): SlashCommandDescriptor =>
    ({ actionId, commandName, targetType });

function check(overrides: Partial<ActionRequirementInput>) {
    return getActionRequirementBlock({
        content: '',
        pills: [],
        actions: [annotate, summarize, colorCode, sort, gaps, custom],
        hasCollectionTarget: false,
        hasDocumentContext: false,
        hasOtherItemContext: false,
        ...overrides,
    });
}

describe('getActionRequirementBlock', () => {
    describe('required argument', () => {
        it('blocks a command that needs text when nothing follows it', () => {
            expect(check({ content: '/annotate ', pills: [pill(annotate.id, 'annotate', 'global')] }))
                .toEqual({ hint: 'Describe what to highlight after /annotate' });
        });

        it('passes once there is text, before or after the command', () => {
            const pills = [pill(annotate.id, 'annotate', 'global')];
            expect(check({ content: '/annotate the methods', pills })).toBeNull();
            expect(check({ content: 'in this paper /annotate', pills })).toBeNull();
        });

        it('does not count another command as text', () => {
            const pills = [pill(annotate.id, 'annotate', 'global'), pill(summarize.id, 'summarize')];
            expect(check({ content: '/annotate /summarize ', pills }))
                .toEqual({ hint: 'Describe what to highlight after /annotate' });
        });

        it('names the command the pill shows, so a renamed command reads right', () => {
            expect(check({ content: '/highlight', pills: [pill(annotate.id, 'highlight', 'global')] }))
                .toEqual({ hint: 'Describe what to highlight after /highlight' });
        });

        it('falls back to a generic lead-in when the action names none', () => {
            expect(check({ content: '/mine', pills: [pill(custom.id, 'mine', 'global')] }))
                .toEqual({ hint: `${DEFAULT_ARGUMENT_REQUIRED_HINT} after /mine` });
        });

        it('does not block a command whose argument is optional', () => {
            expect(check({ content: '/summarize ', pills: [pill(summarize.id, 'summarize')] })).toBeNull();
        });
    });

    describe('targets', () => {
        it('lets a global action through with nothing attached', () => {
            expect(check({ content: '/summarize ', pills: [pill(summarize.id, 'summarize', 'global')] })).toBeNull();
        });

        it('does not check a pill staged without a target type', () => {
            expect(check({ content: '/color-code ', pills: [pill(colorCode.id, 'color-code')] })).toBeNull();
        });

        it('asks for a document for a document action with nothing attached', () => {
            const pills = [pill(colorCode.id, 'color-code', 'attachment')];
            expect(check({ content: '/color-code ', pills }))
                .toEqual({ hint: 'Attach or open a PDF to run /color-code' });
            expect(check({ content: '/color-code ', pills, hasDocumentContext: true })).toBeNull();
            expect(check({ content: '/color-code ', pills, hasCollectionTarget: true })).toBeNull();
        });

        it('does not take an open note as a document', () => {
            expect(check({
                content: '/color-code ',
                pills: [pill(colorCode.id, 'color-code', 'attachment')],
                hasOtherItemContext: true,
            })).toEqual({ hint: 'Attach or open a PDF to run /color-code' });
        });

        it('asks for papers or a collection for an item action with nothing attached', () => {
            const pills = [pill(sort.id, 'sort-into-collections', 'items')];
            expect(check({ content: '/sort-into-collections ', pills }))
                .toEqual({ hint: 'Attach papers or a collection to run /sort-into-collections' });
            expect(check({ content: '/sort-into-collections ', pills, hasDocumentContext: true })).toBeNull();
            expect(check({ content: '/sort-into-collections ', pills, hasCollectionTarget: true })).toBeNull();
            expect(check({ content: '/sort-into-collections ', pills, hasOtherItemContext: true })).toBeNull();
        });

        it('asks for a collection for a collection action, as the send path does', () => {
            const pills = [pill(gaps.id, 'find-gaps', 'collection')];
            expect(check({ content: '/find-gaps ', pills, hasDocumentContext: true }))
                .toEqual({ hint: 'Attach a collection to run /find-gaps' });
            expect(check({ content: '/find-gaps ', pills, hasCollectionTarget: true })).toBeNull();
        });

        it('does not check targets for a prompt that resolves {{variables}} at send time', () => {
            const variables = { id: 'custom-vars', text: 'Summarize {{selected_items}}' };
            expect(check({
                actions: [variables],
                content: '/vars ',
                pills: [pill(variables.id, 'vars', 'items')],
            })).toBeNull();
        });

        it('reports the first unmet requirement in document order', () => {
            const pills = [pill(annotate.id, 'annotate', 'global'), pill(colorCode.id, 'color-code', 'attachment')];
            expect(check({ content: '/annotate /color-code', pills }))
                .toEqual({ hint: 'Describe what to highlight after /annotate' });
            expect(check({ content: '/annotate the methods /color-code', pills }))
                .toEqual({ hint: 'Attach or open a PDF to run /color-code' });
        });
    });

    it('skips pills whose action no longer exists', () => {
        const missing = { ...pill('custom-deleted', 'gone', 'attachment'), missing: true };
        expect(check({ content: '/gone', pills: [missing] })).toBeNull();
        expect(check({ content: '/gone', pills: [pill('custom-deleted', 'gone', 'attachment')] })).toBeNull();
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
