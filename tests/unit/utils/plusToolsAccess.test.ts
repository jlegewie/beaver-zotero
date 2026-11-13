/**
 * Whether the next message gets Plus Tools, and the release card's button for
 * each account state.
 */
import { describe, expect, it } from 'vitest';
import { getPlusToolsAccess, type PlusToolsAccessInput } from '../../../react/utils/plusToolsAccess';
import {
    NO_CREDITS_NOTE,
    PLUS_TOOLS_OFF_NOTE,
    resolveVersionUpdateAction,
} from '../../../react/utils/versionUpdateAction';
import type { VersionUpdateAction } from '../../../react/constants/versionUpdateMessages';

const input = (overrides: Partial<PlusToolsAccessInput> = {}): PlusToolsAccessInput => ({
    gate: null,
    usesBeaverModel: true,
    plusToolsPref: false,
    credits: 10,
    ...overrides,
});

describe('getPlusToolsAccess', () => {
    it('is ready on the Beaver model with credits, whatever the Plus Tools preference', () => {
        expect(getPlusToolsAccess(input())).toEqual({ status: 'ready', model: 'beaver' });
        expect(getPlusToolsAccess(input({ plusToolsPref: true }))).toEqual({ status: 'ready', model: 'beaver' });
    });

    it('is ready on an own model only with Plus Tools on', () => {
        expect(getPlusToolsAccess(input({ usesBeaverModel: false, plusToolsPref: true })))
            .toEqual({ status: 'ready', model: 'own' });
        expect(getPlusToolsAccess(input({ usesBeaverModel: false, plusToolsPref: false })))
            .toEqual({ status: 'plus-tools-off', model: 'own' });
    });

    it('reports missing credits before a Plus Tools preference that would not help', () => {
        expect(getPlusToolsAccess(input({ credits: 0 })))
            .toEqual({ status: 'no-credits', model: 'beaver', plusToolsOn: false });
        expect(getPlusToolsAccess(input({ usesBeaverModel: false, plusToolsPref: false, credits: 0 })))
            .toEqual({ status: 'no-credits', model: 'own', plusToolsOn: false });
        expect(getPlusToolsAccess(input({ usesBeaverModel: false, plusToolsPref: true, credits: -1 })))
            .toEqual({ status: 'no-credits', model: 'own', plusToolsOn: true });
    });

    it('defers to the chat gate while there is no chat to send from', () => {
        expect(getPlusToolsAccess(input({ gate: 'signed-out' }))).toEqual({ status: 'signed-out' });
        expect(getPlusToolsAccess(input({ gate: 'connecting', credits: 0 })))
            .toEqual({ status: 'not-ready', gate: 'connecting' });
        expect(getPlusToolsAccess(input({ gate: 'onboarding' })))
            .toEqual({ status: 'not-ready', gate: 'onboarding' });
    });
});

describe('resolveVersionUpdateAction', () => {
    const table: VersionUpdateAction = {
        type: 'stage-action',
        label: 'Try it',
        actionId: 'builtin-research-table',
        requiresPlusTools: true,
    };
    const resolve = (action: VersionUpdateAction | undefined, overrides: Partial<PlusToolsAccessInput> = {}) =>
        resolveVersionUpdateAction(action, getPlusToolsAccess(input(overrides)));

    it('stages the action for a user who can run it, on either model', () => {
        const staged = { type: 'stage-action', label: 'Try it', actionId: 'builtin-research-table', enablePlusTools: false };
        expect(resolve(table)).toEqual(staged);
        expect(resolve(table, { usesBeaverModel: false, plusToolsPref: true })).toEqual(staged);
    });

    it('offers to turn Plus Tools on for an own-model user with credits, then stages the action', () => {
        expect(resolve(table, { usesBeaverModel: false })).toEqual({
            type: 'stage-action',
            label: 'Turn on Plus Tools',
            actionId: 'builtin-research-table',
            enablePlusTools: true,
            note: PLUS_TOOLS_OFF_NOTE,
        });
    });

    it('points a user without credits to credits instead of a message that cannot run', () => {
        const getCredits = { type: 'get-credits', label: 'Get credits', note: NO_CREDITS_NOTE };
        expect(resolve(table, { credits: 0 })).toEqual(getCredits);
        expect(resolve(table, { credits: 0, usesBeaverModel: false })).toEqual(getCredits);
        expect(resolve(table, { credits: 0, usesBeaverModel: false, plusToolsPref: true })).toEqual(getCredits);
    });

    it('opens Beaver to its sign-in or setup screen when there is no chat yet', () => {
        expect(resolve(table, { gate: 'signed-out' })).toEqual({ type: 'open-beaver', label: 'Sign in to try' });
        expect(resolve(table, { gate: 'restoring' })).toEqual({ type: 'open-beaver', label: 'Open Beaver' });
        expect(resolve({ type: 'quick-prompt', label: 'Try now' }, { gate: 'signed-out' }))
            .toEqual({ type: 'open-beaver', label: 'Sign in to try' });
    });

    it('stages an action that needs no Plus Tools whatever the credits', () => {
        const action: VersionUpdateAction = { type: 'stage-action', label: 'Try it', actionId: 'builtin-x' };
        expect(resolve(action, { credits: 0 }))
            .toEqual({ type: 'stage-action', label: 'Try it', actionId: 'builtin-x', enablePlusTools: false });
    });

    it('keeps URL and plain open actions, and defaults to opening Beaver', () => {
        expect(resolve({ type: 'open-url', label: 'Explore', url: 'https://example.test' }, { gate: 'signed-out' }))
            .toEqual({ type: 'open-url', label: 'Explore', url: 'https://example.test' });
        expect(resolve(undefined, { credits: 0 })).toEqual({ type: 'open-beaver', label: 'Open Beaver' });
        expect(resolve({ type: 'quick-prompt', label: 'Try now' }, { credits: 0 }))
            .toEqual({ type: 'quick-prompt', label: 'Try now' });
    });
});
