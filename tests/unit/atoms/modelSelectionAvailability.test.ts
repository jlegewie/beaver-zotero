/**
 * isModelSelectionAvailableAtom decides two things at once: whether
 * ModelSelectionButton renders, and whether the composer's permission menu
 * takes its slot. These cases pin the row count it mirrors — a lone model under
 * a group header still shows a menu, because the header is a row too.
 */
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => undefined),
    setPref: vi.fn(),
}));
vi.mock('../../../react/types/settings', () => ({
    getCustomChatModelsFromPreferences: vi.fn(() => []),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    isModelSelectionAvailableAtom,
    supportedModelsAtom,
    setApiKeyAtom,
} from '../../../react/atoms/models';
import type { ModelConfig } from '../../../react/atoms/models';

const model = (overrides: Partial<ModelConfig>): ModelConfig => ({
    id: 'm',
    provider: 'anthropic',
    name: 'Model',
    snapshot: 'snapshot',
    context_window: 1000,
    reasoning_model: false,
    supports_vision: false,
    pricing: { input: 0, output: 0 },
    credit_cost: 1,
    is_default: false,
    allow_byok: false,
    allow_app_key: false,
    is_custom: false,
    is_enabled: true,
    ...overrides,
} as ModelConfig);

let store: ReturnType<typeof createStore>;

beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
});

describe('isModelSelectionAvailableAtom', () => {
    it('is false with nothing to choose between', () => {
        store.set(supportedModelsAtom, []);
        expect(store.get(isModelSelectionAvailableAtom)).toBe(false);

        store.set(supportedModelsAtom, [model({ id: 'a', allow_app_key: true })]);
        expect(store.get(isModelSelectionAvailableAtom)).toBe(false);
    });

    it('is true once there are two Beaver models', () => {
        store.set(supportedModelsAtom, [
            model({ id: 'a', allow_app_key: true }),
            model({ id: 'b', allow_app_key: true }),
        ]);

        expect(store.get(isModelSelectionAvailableAtom)).toBe(true);
    });

    it('counts the group header a lone BYOK model arrives under', () => {
        store.set(supportedModelsAtom, [
            model({ id: 'a', provider: 'anthropic', allow_byok: true }),
        ]);
        store.set(setApiKeyAtom, { provider: 'anthropic', value: 'sk-test' });

        expect(store.get(isModelSelectionAvailableAtom)).toBe(true);
    });

    it('ignores a BYOK model with no key for its provider', () => {
        store.set(supportedModelsAtom, [
            model({ id: 'a', allow_app_key: true }),
            model({ id: 'b', provider: 'openai', allow_byok: true }),
        ]);

        expect(store.get(isModelSelectionAvailableAtom)).toBe(false);
    });

    it('ignores a disabled model', () => {
        store.set(supportedModelsAtom, [
            model({ id: 'a', allow_app_key: true }),
            model({ id: 'b', allow_app_key: true, is_enabled: false }),
        ]);

        expect(store.get(isModelSelectionAvailableAtom)).toBe(false);
    });
});
