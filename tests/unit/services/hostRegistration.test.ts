/**
 * Lock on the host registrations in the webpack entry.
 *
 * The transport layer resolves its data provider, client identity, and auth
 * storage from registries that a host fills in. `react/index.tsx` is the only
 * place the Zotero plugin fills them, and it does so at module scope so the
 * calls land before the bundle's `onload` mounts any React root.
 *
 * Dropping or deferring one of these calls type-checks and lints cleanly, and
 * only fails once a user hits the corresponding runtime path — an unregistered
 * storage adapter, for instance, leaves the plugin permanently signed out.
 * Importing the entry here is not viable (it pulls the whole bundle and needs a
 * browser + Zotero host), so assert against its source instead.
 *
 * This checks that each call runs on import, not that the imports resolve
 * (the type checker covers that) and not the order of the calls relative to
 * the first use of what they register.
 *
 * The platform runtime adapter (`registerZoteroRuntime` in
 * `src/platform/zoteroRuntime.ts`) is deliberately absent from this list:
 * some `getPref()` callers read at module scope, so an entry-body call — the
 * pattern every registration below follows — always runs too late, since an
 * entry's imports fully evaluate before its own body (see the comment on the
 * `registerZoteroRuntime()` call in `src/utils/prefs.ts`). That ordering
 * guarantee is locked by `tests/unit/platform/zoteroRuntime.test.ts` instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENTRY = resolve(__dirname, '../../../react/index.tsx');

const REQUIRED_REGISTRATIONS = [
    'registerZoteroHost',
    'registerZoteroDataProvider',
    'registerZoteroObjectIdResolver',
    'registerZoteroClientIdentity',
    'registerZoteroSupabaseStorage',
    'registerZoteroBusyContext',
    'registerZoteroSyncPause',
];

/** Source lines with no leading whitespace, i.e. statements that run on import. */
function moduleScopeLines(source: string): string[] {
    return source.split('\n').filter((line) => line.length > 0 && !/^\s/.test(line));
}

describe('webpack entry host registrations', () => {
    const source = readFileSync(ENTRY, 'utf8');
    const topLevel = moduleScopeLines(source);

    it.each(REQUIRED_REGISTRATIONS)('calls %s at module scope', (name) => {
        expect(topLevel.some((line) => line.startsWith(`${name}(`))).toBe(true);
    });
});
