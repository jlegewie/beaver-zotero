import { describe, it, expect, beforeEach, vi } from 'vitest';

// actionStorage only uses the legacy-import helper from settings; mocking it
// breaks the settings → atoms/ui → atoms/models import cycle in tests.
vi.mock('../../../react/types/settings', () => ({
    getCustomPromptsFromPreferences: () => [],
}));

import { getMergedActions, saveActionCustomizations } from '../../../react/types/actionStorage';
import { BUILTIN_ACTIONS, ALL_BUILTIN_ACTIONS } from '../../../react/types/builtinActions';
import { ARCHIVED_ACTIONS } from '../../../react/types/archivedActions';
import { getActionCommand, toSlashToken } from '../../../react/utils/slashCommands';
import type { ActionCustomizations } from '../../../react/types/actions';

// In-memory pref store backing the Zotero.Prefs stub from tests/setup.ts, so
// customizations round-trip through the real JSON serialization.
const prefStore = new Map<string, unknown>();
const { Prefs } = (globalThis as any).Zotero;

describe('actionStorage', () => {
    beforeEach(() => {
        prefStore.clear();
        vi.mocked(Prefs.get).mockImplementation((key: string) => prefStore.get(key));
        vi.mocked(Prefs.set).mockImplementation((key: string, value: unknown) => {
            prefStore.set(key, value);
        });
    });

    const builtinWithName = BUILTIN_ACTIONS.find(a => a.name)!;

    it('built-in names are unique', () => {
        const commands = BUILTIN_ACTIONS.filter(a => !a.deprecated).map(getActionCommand);
        expect(new Set(commands).size).toBe(commands.length);
    });

    it('applies a name override to a built-in', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [builtinWithName.id]: { name: 'my-command' } },
            custom: [],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === builtinWithName.id)!;
        expect(merged.name).toBe('my-command');
        expect(getActionCommand(merged)).toBe('my-command');
    });

    it('persists a cleared built-in name ("") so the command derives from the title', () => {
        // Clearing back to automatic mode stores "" — a plain `undefined`
        // would be dropped by JSON.stringify and the base name would return.
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [builtinWithName.id]: { title: 'My Custom Digest', name: '' } },
            custom: [],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === builtinWithName.id)!;
        expect(merged.name).toBe('');
        expect(getActionCommand(merged)).toBe(toSlashToken('My Custom Digest'));
        expect(getActionCommand(merged)).not.toBe(builtinWithName.name);
    });

    it('drops undefined override fields in the JSON round-trip (why "" is required)', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [builtinWithName.id]: { title: 'My Custom Digest', name: undefined } },
            custom: [],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === builtinWithName.id)!;
        // The undefined name never reaches storage — the base name survives.
        expect(merged.name).toBe(builtinWithName.name);
    });

    it('persists and merges argumentHint overrides', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [builtinWithName.id]: { argumentHint: 'topic to focus on' } },
            custom: [],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === builtinWithName.id)!;
        expect(merged.argumentHint).toBe('topic to focus on');
    });

    it('keeps name and argumentHint on custom actions', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: {},
            custom: [{
                id: 'custom-1',
                title: 'My Action',
                text: 'Do the thing',
                name: 'my-action',
                argumentHint: 'what to do it to',
                targets: ['global'],
            }],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === 'custom-1')!;
        expect(merged.name).toBe('my-action');
        expect(merged.argumentHint).toBe('what to do it to');
    });

    it('normalizes legacy custom actions (single targetType, minItems) to targets', () => {
        // Older versions stored a single `targetType` string and an optional
        // `minItems`. Readers accept the legacy shape and normalize.
        const legacy = {
            version: 1,
            overrides: {},
            custom: [{
                id: 'custom-legacy',
                title: 'Legacy Action',
                text: 'Do the thing',
                targetType: 'attachment',
                minItems: 2,
            }],
        };
        saveActionCustomizations(legacy as unknown as ActionCustomizations);
        const merged = getMergedActions().find(a => a.id === 'custom-legacy')!;
        expect(merged.targets).toEqual(['attachment']);
        expect((merged as any).targetType).toBeUndefined();
        expect((merged as any).minItems).toBeUndefined();
    });

    it('normalizes a legacy targetType override to targets', () => {
        const legacy = {
            version: 1,
            overrides: { [builtinWithName.id]: { targetType: 'note' } },
            custom: [],
        };
        saveActionCustomizations(legacy as unknown as ActionCustomizations);
        const merged = getMergedActions().find(a => a.id === builtinWithName.id)!;
        expect(merged.targets).toEqual(['note']);
    });

    it('applies a targets override wholesale', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [builtinWithName.id]: { targets: ['items', 'attachment'] } },
            custom: [],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === builtinWithName.id)!;
        expect(merged.targets).toEqual(['items', 'attachment']);
    });

    it('drops stored actions with no valid target in either shape', () => {
        const invalid = {
            version: 1,
            overrides: {},
            custom: [{ id: 'custom-bad', title: 'Bad', text: 'x', targetType: 'bogus' }],
        };
        saveActionCustomizations(invalid as unknown as ActionCustomizations);
        expect(getMergedActions().some(a => a.id === 'custom-bad')).toBe(false);
    });

    // ── Deprecated tombstones (archivedActions.ts) ──────────────────────
    //
    // Retired built-ins that shipped in a released build stay in the base
    // list as `deprecated: true` tombstones: invisible unless the user has
    // an override, in which case the override merges onto the full default.

    const archived = ARCHIVED_ACTIONS[0];

    it('archived tombstones keep full attributes, deprecated flag, and no category', () => {
        for (const a of ARCHIVED_ACTIONS) {
            expect(a.deprecated, a.id).toBe(true);
            expect(a.category, a.id).toBeUndefined();
            expect(a.title, a.id).toBeTruthy();
            expect(a.text, a.id).toBeTruthy();
            expect(a.targets.length, a.id).toBeGreaterThan(0);
        }
        // Tombstone ids must not collide with active built-ins
        const activeIds = new Set(BUILTIN_ACTIONS.map(a => a.id));
        for (const a of ARCHIVED_ACTIONS) {
            expect(activeIds.has(a.id), a.id).toBe(false);
        }
        expect(ALL_BUILTIN_ACTIONS.length).toBe(BUILTIN_ACTIONS.length + ARCHIVED_ACTIONS.length);
    });

    it('hides a deprecated built-in from users without an override', () => {
        saveActionCustomizations({ version: 1, overrides: {}, custom: [] });
        expect(getMergedActions().some(a => a.id === archived.id)).toBe(false);
    });

    it('keeps a deprecated built-in for users with an override, merging base fields', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [archived.id]: { title: 'My renamed action' } },
            custom: [],
        };
        saveActionCustomizations(c);
        const merged = getMergedActions().find(a => a.id === archived.id)!;
        expect(merged).toBeDefined();
        expect(merged.title).toBe('My renamed action');
        // Unmodified fields resolve from the tombstone (including prompt improvements)
        expect(merged.text).toBe(archived.text);
        expect(merged.targets).toEqual(archived.targets);
        // No category → never shown on the homepage launcher
        expect(merged.category).toBeUndefined();
    });

    it('preserves archived built-in commands when an override does not change the name', () => {
        const shippedCommands: Record<string, string> = {
            'builtin-key-findings': 'key-findings',
            'builtin-attachment-fit-research': 'fit-into-library-pdf',
            'builtin-organize-recent': 'organize-recent',
            'builtin-fix-metadata-recent': 'fix-metadata',
        };

        const overrides = Object.fromEntries(
            Object.keys(shippedCommands).map(id => [id, { title: 'My renamed action' }]),
        ) as ActionCustomizations['overrides'];

        saveActionCustomizations({ version: 1, overrides, custom: [] });
        const mergedById = new Map(getMergedActions().map(a => [a.id, a]));

        for (const [id, command] of Object.entries(shippedCommands)) {
            const merged = mergedById.get(id);
            expect(merged, id).toBeDefined();
            expect(getActionCommand(merged!), id).toBe(command);
        }
    });

    it('keeps a hidden deprecated built-in hidden', () => {
        const c: ActionCustomizations = {
            version: 1,
            overrides: { [archived.id]: { hidden: true } },
            custom: [],
        };
        saveActionCustomizations(c);
        expect(getMergedActions().some(a => a.id === archived.id)).toBe(false);
    });
});
