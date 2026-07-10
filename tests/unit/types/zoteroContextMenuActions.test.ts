import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getMergedActions } from '../../../src/modules/zoteroContextMenu';
import { BUILTIN_ACTIONS } from '../../../react/types/builtinActions';

const prefStore = new Map<string, unknown>();
const { Prefs } = (globalThis as any).Zotero;

describe('zoteroContextMenu action merge', () => {
    beforeEach(() => {
        prefStore.clear();
        vi.mocked(Prefs.get).mockImplementation((key: string) => prefStore.get(key));
        vi.mocked(Prefs.set).mockImplementation((key: string, value: unknown) => {
            prefStore.set(key, value);
        });
    });

    it('ignores historical overrides and hidden flags for locked built-ins', () => {
        const lockedBuiltin = BUILTIN_ACTIONS.find(action => action.locked)!;
        prefStore.set('extensions.zotero.beaver.actions', JSON.stringify({
            version: 1,
            overrides: {
                [lockedBuiltin.id]: {
                    hidden: true,
                    title: 'Old customized title',
                    targets: ['note'],
                },
            },
            custom: [],
        }));

        const merged = getMergedActions().find(action => action.id === lockedBuiltin.id);
        expect(merged).toMatchObject({
            title: lockedBuiltin.title,
            targets: lockedBuiltin.targets,
            locked: true,
        });
    });
});
