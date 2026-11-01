import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    checkUrlAllowed,
    isBlockedHost,
    isPrivateAddress,
    minimalWebpageJson,
    translateUrl,
} from '../../../src/services/itemImport/resolveUrl';

describe('isPrivateAddress', () => {
    it.each([
        '0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255',
        '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ])('treats %s as private', (address) => {
        expect(isPrivateAddress(address)).toBe(true);
    });

    it.each([
        '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '169.253.0.1',
        '2001:4860:4860::8888', '::ffff:8.8.8.8', 'example.org',
    ])('treats %s as public', (address) => {
        expect(isPrivateAddress(address)).toBe(false);
    });
});

describe('isBlockedHost', () => {
    it.each([
        '', 'localhost', 'app.localhost', 'printer.local', 'db.internal', 'intranet', '127.0.0.1', '[::1]', '10.0.0.5', 'LOCALHOST', 'localhost.', 'printer.local.',
    ])('blocks %j', (host) => {
        expect(isBlockedHost(host)).toBe(true);
    });

    it.each(['example.org', 'www.nature.com', '8.8.8.8', 'arxiv.org'])('allows %s', (host) => {
        expect(isBlockedHost(host)).toBe(false);
    });
});

describe('checkUrlAllowed', () => {
    it('rejects an unparseable URL', async () => {
        const result = await checkUrlAllowed('not a url');
        expect(result).toMatchObject({ ok: false });
        expect((result as any).message).toContain('not a valid URL');
    });

    it.each(['file:///etc/passwd', 'ftp://example.org/a', 'javascript:alert(1)', 'data:text/html,hi'])(
        'rejects non-http scheme %s',
        async (url) => {
            const result = await checkUrlAllowed(url);
            expect(result).toMatchObject({ ok: false, message: 'Only http(s) URLs can be imported.' });
        },
    );

    it.each([
        'http://localhost:8080/x',
        'http://127.0.0.1/',
        'https://192.168.0.10/admin',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/',
        'http://intranet/wiki',
    ])('rejects local or private target %s', async (url) => {
        const result = await checkUrlAllowed(url);
        expect(result).toMatchObject({ ok: false, message: 'Local and private-network addresses cannot be imported.' });
    });

    /** Gecko's DNS service, answering every lookup with `addresses` (or failing with `status`). */
    function stubDns(addresses: string[], status = 0) {
        const g = globalThis as any;
        g.Components = {
            classes: {
                '@mozilla.org/network/dns-service;1': {
                    getService: () => ({
                        asyncResolve: (_host: string, _type: number, _flags: number, _info: unknown, listener: any) => {
                            const queue = [...addresses];
                            listener.onLookupComplete(null, status === 0 ? {
                                QueryInterface: () => {},
                                hasMore: () => queue.length > 0,
                                getNextAddrAsString: () => queue.shift(),
                            } : null, status);
                        },
                    }),
                },
            },
            interfaces: { nsIDNSService: { RESOLVE_TYPE_DEFAULT: 0 }, nsIDNSAddrRecord: {} },
        };
        g.Services = { tm: { currentThread: {} } };
    }

    it('allows a public https URL and returns the parsed URL', async () => {
        stubDns(['93.184.216.34']);
        const result = await checkUrlAllowed('https://example.org/paper?id=1');
        expect(result.ok).toBe(true);
        expect((result as any).parsed.hostname).toBe('example.org');
    });

    it('rejects a public name that resolves to a private address', async () => {
        stubDns(['93.184.216.34', '10.0.0.7']);
        expect(await checkUrlAllowed('https://rebind.example.org/')).toMatchObject({ ok: false, code: 'url_not_allowed' });
    });

    it('charges the DNS check to the translation budget', async () => {
        stubDns(['93.184.216.34']);
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValueOnce(1_000).mockReturnValue(9_000);
        try {
            expect(await translateUrl('https://example.org/', 5_000)).toMatchObject({ ok: false, code: 'timeout' });
        } finally {
            now.mockRestore();
        }
    });

    it('never allows a host whose lookup fails', async () => {
        stubDns([], 0x804b001e);
        expect(await checkUrlAllowed('https://unknown.example.org/')).toMatchObject({ ok: false, code: 'unreachable' });
    });

    it('allows a public IPv4 literal', async () => {
        expect((await checkUrlAllowed('http://8.8.8.8/')).ok).toBe(true);
    });
});

describe('minimalWebpageJson', () => {
    it('builds a webpage item from the page title and host', () => {
        expect(minimalWebpageJson('https://www.example.org/a/b', ' A Page ')).toEqual({
            itemType: 'webpage',
            title: 'A Page',
            url: 'https://www.example.org/a/b',
            websiteTitle: 'example.org',
        });
    });

    it('falls back to the host, then the URL, for the title', () => {
        expect(minimalWebpageJson('https://www.example.org/a', undefined).title).toBe('example.org');
        const invalid = minimalWebpageJson('not-a-url', '');
        expect(invalid.title).toBe('not-a-url');
        expect(invalid).not.toHaveProperty('websiteTitle');
    });
});

describe('IPv4-mapped IPv6 in the hex spelling URL parsing produces', () => {
    it.each(['::ffff:7f00:1', '::ffff:c0a8:101', '::ffff:a00:1'])('treats %s as private', (address) => {
        expect(isPrivateAddress(address)).toBe(true);
    });

    it('allows a mapped public address', () => {
        expect(isPrivateAddress('::ffff:808:808')).toBe(false); // 8.8.8.8
    });

    it('blocks the hostname of http://[::ffff:127.0.0.1]/', () => {
        expect(isBlockedHost(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe(true);
    });
});
