/**
 * The answer rules behind the batch approval card.
 *
 * These pin the semantics a client's card must not drift from: which mode a
 * card starts on, when a transition is a no-op, and exactly what leaves the
 * client on the wire. The rules live in a host-free module precisely so they
 * can be exercised here as plain functions, with no DOM and no component in
 * the way.
 */
import { describe, expect, it } from 'vitest';

import type { BatchApprovalDraft } from '@beaver/agent-core/run-state/batchApprovalAnswers';
import {
    DEFAULT_BATCH_APPROVAL_DRAFT,
    buildResponse,
    initialDraft,
    setMode,
    setUserInstructions,
} from '@beaver/agent-core/run-state/batchApprovalAnswers';

describe('DEFAULT_BATCH_APPROVAL_DRAFT', () => {
    it('starts on full access with no instructions', () => {
        expect(DEFAULT_BATCH_APPROVAL_DRAFT).toEqual({
            mode: 'full_access',
            userInstructions: '',
        });
    });
});

describe('initialDraft', () => {
    it('seeds the mode the request preselects', () => {
        expect(initialDraft('ask_each_time')).toEqual({
            mode: 'ask_each_time',
            userInstructions: '',
        });
    });

    it('reuses the default draft when the request preselects full access', () => {
        expect(initialDraft('full_access')).toBe(DEFAULT_BATCH_APPROVAL_DRAFT);
    });
});

describe('setMode', () => {
    it('returns a new draft with the chosen mode', () => {
        const next = setMode('ask_each_time', DEFAULT_BATCH_APPROVAL_DRAFT);

        expect(next.mode).toBe('ask_each_time');
        expect(next).not.toBe(DEFAULT_BATCH_APPROVAL_DRAFT);
        // The transition is pure: the draft it was given is untouched.
        expect(DEFAULT_BATCH_APPROVAL_DRAFT.mode).toBe('full_access');
    });

    it('keeps the instructions typed so far', () => {
        const typed = setUserInstructions('keep p53', DEFAULT_BATCH_APPROVAL_DRAFT);

        expect(setMode('ask_each_time', typed).userInstructions).toBe('keep p53');
    });

    it('returns the same draft when the mode is unchanged', () => {
        expect(setMode('full_access', DEFAULT_BATCH_APPROVAL_DRAFT)).toBe(DEFAULT_BATCH_APPROVAL_DRAFT);
    });
});

describe('setUserInstructions', () => {
    it('stores the text verbatim, whitespace and all', () => {
        const next = setUserInstructions('  keep p53 and p63  ', DEFAULT_BATCH_APPROVAL_DRAFT);

        expect(next.userInstructions).toBe('  keep p53 and p63  ');
        expect(next).not.toBe(DEFAULT_BATCH_APPROVAL_DRAFT);
    });

    it('returns the same draft when the text is unchanged', () => {
        const typed = setUserInstructions('keep p53', DEFAULT_BATCH_APPROVAL_DRAFT);

        expect(setUserInstructions('keep p53', typed)).toBe(typed);
    });
});

describe('buildResponse', () => {
    const withInstructions: BatchApprovalDraft = setUserInstructions(
        '  keep p53 and p63  ',
        setMode('ask_each_time', DEFAULT_BATCH_APPROVAL_DRAFT),
    );

    it('trims the instructions at read time', () => {
        expect(buildResponse(withInstructions, true)).toEqual({
            approved: true,
            mode: 'ask_each_time',
            user_instructions: 'keep p53 and p63',
        });
    });

    it('carries mode and instructions on a decline too', () => {
        // Declining cancels the batch; the instructions are how the user says
        // what to do instead.
        expect(buildResponse(withInstructions, false)).toEqual({
            approved: false,
            mode: 'ask_each_time',
            user_instructions: 'keep p53 and p63',
        });
    });

    it('sends no instructions when nothing was typed', () => {
        expect(buildResponse(DEFAULT_BATCH_APPROVAL_DRAFT, true)).toEqual({
            approved: true,
            mode: 'full_access',
            user_instructions: null,
        });
    });

    it('sends no instructions when only whitespace was typed', () => {
        const blank = setUserInstructions('   \n  ', DEFAULT_BATCH_APPROVAL_DRAFT);

        expect(buildResponse(blank, true).user_instructions).toBeNull();
    });
});
