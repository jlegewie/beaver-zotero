import { describe, expect, it } from 'vitest';
import { answeredPromptKey, promptKey } from '@beaver/agent-core/transport/runLink';

describe('table card on the run link', () => {
    it('pairs a card with its answer, so a reattach can replay or retire it', () => {
        expect(promptKey({ event: 'table_card_request', card_id: 'card-1' } as any)).toBe('table_card_request:card-1');
        expect(answeredPromptKey({ type: 'table_card_response', card_id: 'card-1', approved: true })).toBe(
            'table_card_request:card-1',
        );
        expect(answeredPromptKey({ type: 'table_card_response', approved: true })).toBeNull();
    });
});
