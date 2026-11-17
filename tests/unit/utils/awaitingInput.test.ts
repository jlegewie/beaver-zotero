import { describe, it, expect } from 'vitest';
import { awaitingIndicator, awaitingInputLabel, parseAwaitingInput } from '../../../src/services/threads/awaitingInput';

describe('parseAwaitingInput', () => {
    it('keeps positive whole counts by kind', () => {
        expect(parseAwaitingInput({ ask_user_question: 2, batch_approval: 1 }))
            .toEqual({ ask_user_question: 2, batch_approval: 1 });
    });

    it('reads null, an empty object and malformed values as not waiting', () => {
        expect(parseAwaitingInput(null)).toBeNull();
        expect(parseAwaitingInput(undefined)).toBeNull();
        expect(parseAwaitingInput({})).toBeNull();
        expect(parseAwaitingInput([1])).toBeNull();
        expect(parseAwaitingInput('ask_user_question')).toBeNull();
        expect(parseAwaitingInput({ ask_user_question: 0, table_card: -1, batch_approval: 1.5, x: '2' })).toBeNull();
    });

    it('drops unusable counts and keeps the rest', () => {
        expect(parseAwaitingInput({ ask_user_question: 0, table_card: 1 })).toEqual({ table_card: 1 });
    });
});

describe('awaitingInputLabel', () => {
    it('names a single kind of card', () => {
        expect(awaitingInputLabel({ ask_user_question: 1 })).toBe('Waiting for your answer to a question');
        expect(awaitingInputLabel({ ask_user_question: 3 })).toBe('Waiting for your answers to 3 questions');
        expect(awaitingInputLabel({ agent_action_approval: 1 })).toBe('Waiting for your approval');
        expect(awaitingInputLabel({ table_card: 2 })).toBe('Waiting for you to confirm 2 tables');
    });

    it('counts action and batch approvals together', () => {
        expect(awaitingInputLabel({ agent_action_approval: 1, batch_approval: 1 })).toBe('Waiting for 2 approvals');
    });

    it('lists mixed kinds in a fixed order', () => {
        expect(awaitingInputLabel({ table_card: 1, ask_user_question: 1 }))
            .toBe('Waiting for your input: 1 question and 1 table');
        expect(awaitingInputLabel({ batch_approval: 2, table_card: 1, ask_user_question: 2 }))
            .toBe('Waiting for your input: 2 questions, 2 approvals and 1 table');
    });

    it('falls back to the generic phrase for a kind it does not know', () => {
        expect(awaitingInputLabel({ ask_user_question: 1, new_card: 1 })).toBe('Waiting for your input');
    });
});

describe('job calls in the thread list', () => {
    it('draws a spinner while only jobs work for the thread', () => {
        expect(awaitingIndicator({ table_fill: 1 })).toBe('spinner');
        expect(awaitingIndicator({ table_fill: 1, pdf_retrieval: 1 })).toBe('spinner');
        expect(awaitingInputLabel({ table_fill: 1 })).toBe('Filling a table');
        expect(awaitingInputLabel({ table_fill: 1, pdf_retrieval: 1 })).toBe('Filling a table · Finding PDFs');
    });

    it('draws the dot once a job result is ready, or the user has something to answer', () => {
        expect(awaitingIndicator({ job_ready: 1 })).toBe('dot');
        expect(awaitingIndicator({ table_fill: 1, ask_user_question: 1 })).toBe('dot');
        expect(awaitingInputLabel({ job_ready: 1 })).toBe('Finished · ready to continue');
        expect(awaitingInputLabel({ job_ready: 2 })).toBe('2 jobs finished · ready to continue');
    });

    it('describes only what needs the user when a job also works', () => {
        expect(awaitingInputLabel({ table_fill: 1, ask_user_question: 1 })).toBe('Waiting for your answer to a question');
    });

    it('reads an unknown key as needing the user', () => {
        expect(awaitingIndicator({ new_job_kind: 1 })).toBe('dot');
    });
});
