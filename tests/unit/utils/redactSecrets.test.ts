import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../react/utils/redactSecrets';

const SECRET = 'sk-secret-value';

const customModel = () => ({
    id: 'custom:gateway',
    is_custom: true,
    custom_model: { api_base: 'https://gateway.example/v1', format: 'openai', api_key: SECRET, snapshot: 'gateway-pro' },
});

describe('redactSecrets', () => {
    it('masks custom-model keys in atoms and JSON-encoded preferences', () => {
        const state = {
            selectedModel: customModel(),
            availableModels: [customModel()],
            wsRequestAckData: { modelName: 'Gateway', chargeType: 'user_api_key' },
            flags: { has_user_api_key: true },
        };
        const prefs = {
            openAiApiKey: 'sk-openai',
            anthropicApiKey: null,
            lastUsedModel: JSON.stringify(customModel()),
        };

        const redactedState = redactSecrets(state);
        const redactedPrefs = redactSecrets(prefs);

        expect(JSON.stringify([redactedState, redactedPrefs])).not.toContain(SECRET);
        expect(JSON.stringify(redactedPrefs)).not.toContain('sk-openai');
        expect(redactedState.selectedModel.custom_model.api_key).toBe('[MASKED]');
        expect(redactedState.availableModels[0].custom_model.snapshot).toBe('gateway-pro');
        expect(redactedState.wsRequestAckData.chargeType).toBe('user_api_key');
        expect(redactedState.flags.has_user_api_key).toBe(true);
        expect(redactedPrefs.openAiApiKey).toBe('[MASKED]');
        expect(redactedPrefs.anthropicApiKey).toBeNull();
        expect(JSON.parse(redactedPrefs.lastUsedModel).custom_model).toEqual({
            ...customModel().custom_model,
            api_key: '[MASKED]',
        });
    });

    it('leaves the input untouched', () => {
        const state = { selectedModel: customModel() };
        redactSecrets(state);
        expect(state.selectedModel.custom_model.api_key).toBe(SECRET);
    });
});
