import { describe, expect, it, vi } from 'vitest';
import { saveAsNoteMenuItem } from '../../../react/utils/saveNoteMenu';

describe('saveAsNoteMenuItem', () => {
    it('names the item a child note would be saved under', () => {
        const onSaveStandalone = vi.fn();
        const onSaveChild = vi.fn();
        const item = saveAsNoteMenuItem({ onSaveStandalone, onSaveChild, hasParent: true, parentTitle: 'Policing and schooling' });
        expect(item.label).toBe('Save as note');
        expect(item.submenu?.map(entry => [entry.label, !!entry.disabled])).toEqual([
            ['Standalone note', false],
            ['Child note of “Policing and schooling”', false],
        ]);
        item.submenu?.[0].onClick();
        item.submenu?.[1].onClick();
        expect(onSaveStandalone).toHaveBeenCalledTimes(1);
        expect(onSaveChild).toHaveBeenCalledTimes(1);
    });

    it('cuts a long title', () => {
        const item = saveAsNoteMenuItem({
            onSaveStandalone: vi.fn(), onSaveChild: vi.fn(), hasParent: true,
            parentTitle: 'An Efficiency Comparison of Document Preparation Systems Used in Academic Research',
        });
        const label = item.submenu![1].label;
        expect(label.startsWith('Child note of “An Efficiency Comparison')).toBe(true);
        expect(label.endsWith('…”')).toBe(true);
        expect(label.length).toBeLessThan(60);
    });

    it('keeps the child note listed but disabled, saying why, when there is no item', () => {
        const item = saveAsNoteMenuItem({ onSaveStandalone: vi.fn(), onSaveChild: vi.fn(), hasParent: false });
        expect(item.submenu?.[1]).toMatchObject({ label: 'Child note (no item selected)', disabled: true });
        expect(item.submenu?.[0].disabled).toBe(false);
    });

    it('falls back to a plain label when the parent cannot be named, and disables everything together', () => {
        const unnamed = saveAsNoteMenuItem({ onSaveStandalone: vi.fn(), onSaveChild: vi.fn(), hasParent: true, parentTitle: null });
        expect(unnamed.submenu?.[1]).toMatchObject({ label: 'Child note', disabled: false });
        const busy = saveAsNoteMenuItem({ onSaveStandalone: vi.fn(), onSaveChild: vi.fn(), hasParent: true, parentTitle: 'X', disabled: true });
        expect(busy.disabled).toBe(true);
        expect(busy.submenu?.every(entry => entry.disabled)).toBe(true);
    });
});
