import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockSupabase } = vi.hoisted(() => ({
    mockLogger: vi.fn(),
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: mockLogger }));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: mockSupabase }));

type ConfigModule = typeof import('@beaver/agent-core/transport/config');
type ApiServiceModule = typeof import('@beaver/agent-core/transport/apiService');

/**
 * The seam keeps its registration in module state, so each test loads a fresh
 * generation to start from "nothing registered".
 */
async function loadModules(): Promise<ConfigModule & ApiServiceModule> {
    vi.resetModules();
    const config = await import('@beaver/agent-core/transport/config');
    const apiService = await import('@beaver/agent-core/transport/apiService');
    return { ...config, ...apiService };
}

beforeEach(() => {
    mockLogger.mockClear();
    mockSupabase.auth.getSession.mockReset();
    mockSupabase.auth.getSession.mockResolvedValue({
        data: {
            session: {
                access_token: 'token',
                expires_at: Math.floor(Date.now() / 1000) + 3600,
            },
        },
        error: null,
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getApiBaseUrl', () => {
    it('returns an empty base URL when no host has registered config', async () => {
        const { getApiBaseUrl } = await loadModules();

        expect(getApiBaseUrl()).toBe('');
    });

    it('warns once when nothing was ever registered', async () => {
        const { getApiBaseUrl } = await loadModules();

        getApiBaseUrl();
        getApiBaseUrl();

        expect(mockLogger).toHaveBeenCalledTimes(1);
    });

    it('does not warn when a host deliberately registers an empty base URL', async () => {
        const { getApiBaseUrl, setTransportConfig } = await loadModules();
        setTransportConfig({ apiBaseUrl: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon' });

        expect(getApiBaseUrl()).toBe('');
        expect(mockLogger).not.toHaveBeenCalled();
    });

    it('returns the registered base URL', async () => {
        const { getApiBaseUrl, setTransportConfig } = await loadModules();
        setTransportConfig({
            apiBaseUrl: 'https://api.example.com',
            supabaseUrl: 'https://p.supabase.co',
            supabaseAnonKey: 'anon',
        });

        expect(getApiBaseUrl()).toBe('https://api.example.com');
    });
});

describe('isTransportConfigRegistered', () => {
    it('separates an unconfigured backend from one registered with an empty base URL', async () => {
        const { isTransportConfigRegistered, setTransportConfig } = await loadModules();

        expect(isTransportConfigRegistered()).toBe(false);

        setTransportConfig({ apiBaseUrl: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon' });

        expect(isTransportConfigRegistered()).toBe(true);
    });
});

describe('getSupabaseConfig', () => {
    it('throws when no host has registered config', async () => {
        const { getSupabaseConfig } = await loadModules();

        expect(() => getSupabaseConfig()).toThrow('No Supabase URL or anon key configured');
    });

    it('throws when the registered project URL is blank', async () => {
        const { getSupabaseConfig, setTransportConfig } = await loadModules();
        setTransportConfig({ apiBaseUrl: '', supabaseUrl: '', supabaseAnonKey: 'anon' });

        expect(() => getSupabaseConfig()).toThrow('No Supabase URL or anon key configured');
    });

    it('throws when the registered anon key is blank', async () => {
        const { getSupabaseConfig, setTransportConfig } = await loadModules();
        setTransportConfig({ apiBaseUrl: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: '' });

        expect(() => getSupabaseConfig()).toThrow('No Supabase URL or anon key configured');
    });

    it('accepts re-registration that keeps the project a client already uses', async () => {
        const { getApiBaseUrl, getSupabaseConfig, markSupabaseConfigInUse, setTransportConfig } = await loadModules();
        setTransportConfig({ apiBaseUrl: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon' });
        markSupabaseConfigInUse(getSupabaseConfig());

        setTransportConfig({
            apiBaseUrl: 'https://api.example.com',
            supabaseUrl: 'https://p.supabase.co',
            supabaseAnonKey: 'anon',
        });

        expect(getApiBaseUrl()).toBe('https://api.example.com');
    });

    it('rejects a project change once a client has been created', async () => {
        const { getSupabaseConfig, markSupabaseConfigInUse, setTransportConfig } = await loadModules();
        setTransportConfig({ apiBaseUrl: '', supabaseUrl: 'https://a.supabase.co', supabaseAnonKey: 'anon' });
        markSupabaseConfigInUse(getSupabaseConfig());

        expect(() =>
            setTransportConfig({ apiBaseUrl: '', supabaseUrl: 'https://b.supabase.co', supabaseAnonKey: 'anon' })
        ).toThrow('Supabase configuration cannot change');
    });

    it('returns the registered project URL and anon key', async () => {
        const { getSupabaseConfig, setTransportConfig } = await loadModules();
        setTransportConfig({
            apiBaseUrl: '',
            supabaseUrl: 'https://p.supabase.co',
            supabaseAnonKey: 'anon',
        });

        expect(getSupabaseConfig()).toEqual({ url: 'https://p.supabase.co', anonKey: 'anon' });
    });
});

describe('backend clients resolving the base URL', () => {
    /** The URL the service actually requested. */
    async function requestedUrl(service: { get(endpoint: string): Promise<unknown> }): Promise<string> {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        await service.get('/api/v1/ping');
        return fetchMock.mock.calls[0][0] as string;
    }

    it('uses config registered after the service was constructed', async () => {
        const { ApiService, setTransportConfig } = await loadModules();

        const service = new ApiService();
        setTransportConfig({
            apiBaseUrl: 'https://late.example.com',
            supabaseUrl: 'https://p.supabase.co',
            supabaseAnonKey: 'anon',
        });

        expect(await requestedUrl(service)).toBe('https://late.example.com/api/v1/ping');
    });

    it('prefers an explicit constructor base URL over the registered config', async () => {
        const { ApiService, setTransportConfig } = await loadModules();
        setTransportConfig({
            apiBaseUrl: 'https://registered.example.com',
            supabaseUrl: 'https://p.supabase.co',
            supabaseAnonKey: 'anon',
        });

        const service = new ApiService('https://pinned.example.com');

        expect(await requestedUrl(service)).toBe('https://pinned.example.com/api/v1/ping');
    });
});
