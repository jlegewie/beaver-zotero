import { describe, expect, it } from 'vitest';

import { getActionLabel, getActionTitle } from '../../../react/host/zotero/components/agentActionViewHelpers';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

const action = (proposed_data: Record<string, any>): AgentAction => ({
    action_type: 'import_item',
    proposed_data,
} as any);

describe('getActionTitle for create_items', () => {
    describe('before any action is stored (approval requests)', () => {
        it('does not read the tool arguments as a title', () => {
            const items = [{ id: '10.1/a' }, { id: 'https://x.org' }];
            expect(getActionTitle('create_items', { items }, null, [])).toBe('Item');
        });

        it('keeps the legacy behavior for items that carry a source_id', () => {
            const legacy = { items: [{ source_id: 'W1', title: 'Legacy A' }, { source_id: 'W2', title: 'Legacy B' }] };
            expect(getActionTitle('create_items', legacy, null, [])).toBe('Item');
        });

        it('shows the title of a single v2 item from the approval request', () => {
            expect(getActionTitle('create_items', { items_count: 1, titles: ['A Paper'] }, null, [])).toBe('A Paper');
        });

        it('shows the count for a v2 approval request', () => {
            expect(getActionTitle('create_items', { items_count: 4 }, null, [])).toBe('4 Items');
        });

        it('shows no count for a single item', () => {
            expect(getActionTitle('create_items', { items_count: 1 }, null, [])).toBe('Item');
        });

        it('uses the legacy single-item title from the action data', () => {
            expect(getActionTitle('create_item', { item: { title: 'Pending paper' } }, null, [])).toBe('Pending paper');
        });
    });

    describe('once actions exist', () => {
        it('titles a single action by its item', () => {
            expect(getActionTitle('create_items', { items: [{ doi: 'x' }] }, null, [action({ item: { title: 'Deep learning' } })]))
                .toBe('Deep learning');
        });

        it('titles a citation-derived action by its fallback metadata', () => {
            const pending = action({ pending_resolution: { fallback_item: { itemType: 'book', title: 'From citation' } } });
            expect(getActionTitle('import_item', undefined, null, [pending])).toBe('From citation');
        });

        it('counts several actions', () => {
            const actions = [action({ item: { title: 'A' } }), action({ item: { title: 'B' } })];
            expect(getActionTitle('create_items', { items: [{}, {}] }, null, actions)).toBe('2 Items');
        });

        it('falls back to a generic title for an action without a title', () => {
            expect(getActionTitle('import_item', undefined, null, [action({})])).toBe('Item');
        });

        it('truncates a long title', () => {
            const long = 'x'.repeat(200);
            const title = getActionTitle('import_item', undefined, null, [action({ item: { title: long } })]);
            expect(title!.length).toBeLessThan(long.length);
        });
    });
});

describe('getActionLabel for import_item', () => {
    it('labels import actions like create_item', () => {
        expect(getActionLabel('import_item')).toBe('Import');
        expect(getActionLabel('import_item', undefined, true)).toBe('Imported');
        expect(getActionLabel('import_item', undefined, true)).toBe(getActionLabel('create_item', undefined, true));
    });
});
