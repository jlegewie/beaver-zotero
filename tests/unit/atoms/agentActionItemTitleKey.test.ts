import { describe, expect, it } from 'vitest';
import { getAgentActionItemTitleKey } from '../../../react/atoms/messageUIState';

describe('getAgentActionItemTitleKey', () => {
    it('keeps reused tool-call ids separate across continuation runs', () => {
        expect(getAgentActionItemTitleKey('run-1', 'call-1'))
            .not.toBe(getAgentActionItemTitleKey('run-2', 'call-1'));
    });
});
