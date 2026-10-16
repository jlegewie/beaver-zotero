import { describe, it, expect } from 'vitest';
import {
    customEndpointFormatHint,
    isCustomChatModel,
    isOpenRouterApiBase,
    normalizeCustomModelFormat,
} from '@beaver/agent-core/types/customChatModel';

const base = { api_base: 'https://api.example.com/v1', api_key: 'k', name: 'n', snapshot: 's' };

describe('custom model format', () => {
    it('accepts the three formats', () => {
        expect(isCustomChatModel({ ...base, format: 'openai' })).toBe(true);
        expect(isCustomChatModel({ ...base, format: 'openai_responses' })).toBe(true);
        expect(isCustomChatModel({ ...base, format: 'anthropic' })).toBe(true);
        expect(isCustomChatModel({ ...base, format: 'responses' })).toBe(false);
    });

    it('normalizes unknown values to Chat Completions', () => {
        expect(normalizeCustomModelFormat('openai_responses')).toBe('openai_responses');
        expect(normalizeCustomModelFormat('anthropic')).toBe('anthropic');
        expect(normalizeCustomModelFormat(undefined)).toBe('openai');
        expect(normalizeCustomModelFormat('bogus')).toBe('openai');
    });
});

describe('customEndpointFormatHint', () => {
    it('points a Responses URL at the Responses format', () => {
        const hint = customEndpointFormatHint('https://api.example.com/v1/responses/', 'openai');
        expect(hint).toContain("'OpenAI Responses'");
    });

    it('points a Chat Completions URL at the Chat Completions format', () => {
        const hint = customEndpointFormatHint('https://api.example.com/v1/chat/completions', 'openai_responses');
        expect(hint).toContain("'OpenAI Chat Completions'");
    });

    it('stays quiet for OpenRouter, which ignores the format', () => {
        expect(customEndpointFormatHint('https://openrouter.ai/api/v1/responses', 'openai')).toBeNull();
        expect(customEndpointFormatHint('https://openrouter.ai/api/v1/chat/completions', 'anthropic')).toBeNull();
    });

    it('stays quiet when the URL and format agree or the URL names no API', () => {
        expect(customEndpointFormatHint('https://api.example.com/v1/responses', 'openai_responses')).toBeNull();
        expect(customEndpointFormatHint('https://api.example.com/v1/chat/completions', 'openai')).toBeNull();
        expect(customEndpointFormatHint('https://api.example.com/v1', 'openai_responses')).toBeNull();
        expect(customEndpointFormatHint(undefined, 'openai')).toBeNull();
    });
});

describe('isOpenRouterApiBase', () => {
    it('matches OpenRouter hosts only', () => {
        expect(isOpenRouterApiBase('https://openrouter.ai/api/v1')).toBe(true);
        expect(isOpenRouterApiBase(' https://eu.openrouter.ai/api/v1 ')).toBe(true);
        expect(isOpenRouterApiBase('https://openrouter.ai.evil.dev/api/v1')).toBe(false);
        expect(isOpenRouterApiBase('https://notopenrouter.ai/api/v1')).toBe(false);
        expect(isOpenRouterApiBase('not a url')).toBe(false);
        expect(isOpenRouterApiBase(undefined)).toBe(false);
    });
});
