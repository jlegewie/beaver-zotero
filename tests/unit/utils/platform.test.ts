import { describe, expect, it } from 'vitest';

import { isMacPlatform, isWindowsPlatform } from '@beaver/agent-ui/utils/platform';

/**
 * Builds the narrow slice of Navigator the helpers read. `userAgentData` is
 * absent on Gecko (which Zotero runs on), so both shapes are exercised.
 */
function navigatorStub(fields: {
    userAgentDataPlatform?: string;
    platform?: string;
    userAgent?: string;
}): Navigator {
    const stub: Record<string, unknown> = {
        platform: fields.platform ?? '',
        userAgent: fields.userAgent ?? '',
    };
    if (fields.userAgentDataPlatform !== undefined) {
        stub.userAgentData = { platform: fields.userAgentDataPlatform };
    }
    return stub as unknown as Navigator;
}

describe('platform flags', () => {
    it('reads the platform from userAgentData when the engine provides it', () => {
        const mac = navigatorStub({ userAgentDataPlatform: 'macOS' });
        expect(isMacPlatform(mac)).toBe(true);
        expect(isWindowsPlatform(mac)).toBe(false);

        const windows = navigatorStub({ userAgentDataPlatform: 'Windows' });
        expect(isWindowsPlatform(windows)).toBe(true);
        expect(isMacPlatform(windows)).toBe(false);

        const linux = navigatorStub({ userAgentDataPlatform: 'Linux' });
        expect(isMacPlatform(linux)).toBe(false);
        expect(isWindowsPlatform(linux)).toBe(false);
    });

    it('falls back to navigator.platform where userAgentData is absent', () => {
        const mac = navigatorStub({
            platform: 'MacIntel',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/128.0',
        });
        expect(isMacPlatform(mac)).toBe(true);
        expect(isWindowsPlatform(mac)).toBe(false);

        for (const platform of ['Win32', 'Win64']) {
            const windows = navigatorStub({
                platform,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/128.0',
            });
            expect(isWindowsPlatform(windows)).toBe(true);
            expect(isMacPlatform(windows)).toBe(false);
        }

        const linux = navigatorStub({
            platform: 'Linux x86_64',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/128.0',
        });
        expect(isMacPlatform(linux)).toBe(false);
        expect(isWindowsPlatform(linux)).toBe(false);
    });

    it('prefers userAgentData over a disagreeing navigator.platform', () => {
        const spoofed = navigatorStub({
            userAgentDataPlatform: 'macOS',
            platform: 'Win32',
        });
        expect(isMacPlatform(spoofed)).toBe(true);
        expect(isWindowsPlatform(spoofed)).toBe(false);
    });

    it('falls back to the user-agent string when no platform field is populated', () => {
        const mac = navigatorStub({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) AppleWebKit/537.36',
        });
        expect(isMacPlatform(mac)).toBe(true);

        const windows = navigatorStub({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        });
        expect(isWindowsPlatform(windows)).toBe(true);
    });

    it('reports neither platform when the navigator exposes nothing usable', () => {
        const empty = navigatorStub({});
        expect(isMacPlatform(empty)).toBe(false);
        expect(isWindowsPlatform(empty)).toBe(false);
    });
});
