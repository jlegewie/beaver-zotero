import { describe, it, expect } from 'vitest';
import { awaitingInputLabel, parseAwaitingInput } from '../../../src/services/threads/awaitingInput';

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
