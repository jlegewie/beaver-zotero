/**
 * Reader sidebar-width wrapper lifecycle live suite.
 *
 * Exercises the real `src/runtime/readerWidth.ts` unwrap/restore logic for
 * `Zotero.Reader.onChangeSidebarWidth` wrappers via the dev-only
 * `/beaver/test/sidebar-width-handler` endpoint. The unit tests
 * (`tests/unit/utils/readerSidebarWidthHandler.test.ts`) cover the same logic
 * against stubbed globals; this suite's load-bearing value is confirming the
 * parts the unit tests can only fake:
 *   - the marker property (`__beaverOriginalSidebarWidthHandler`) is visible
 *     via `in` on functions round-tripped through the real reader slot,
 *   - `Function.prototype.toString` source sniffing identifies legacy
 *     (pre-marker) wrappers in the real chrome context,
 *   - restore identity semantics hold on the real `Zotero.Reader` singleton, and
 *   - the running plugin instance leaves no Beaver wrapper in the slot.
 *
 * Every mutating scenario snapshots and restores the slot server-side, so the
 * suite leaves the running UI untouched.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the dev-only test endpoints are registered.
 *
 * Run with: `npm run test:live -- sidebarWidthHandler`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { sidebarWidthScenario } from '../helpers/cacheInspector';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('running instance health', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('leaves no Beaver wrapper in the reader slot', async () => {
        const res = await sidebarWidthScenario('inspect');
        expect(res.ok).toBe(true);
        expect(res.taggedLayers).toBe(0);
        expect(['null', 'function']).toContain(res.bottom);
    });
});

describe('restore path (restoreReaderSidebarWidthHandler)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('unwinds a wrapper chain back to the pre-existing handler', async () => {
        const res = await sidebarWidthScenario('restore-unwinds-own');
        expect(res).toMatchObject({ ok: true, slotIsBase: true });
    });

    it('clears a bare legacy wrapper left by an older plugin version to null', async () => {
        const res = await sidebarWidthScenario('restore-clears-bare-legacy');
        expect(res).toMatchObject({ ok: true, slotIsNull: true });
    });

    it('leaves a foreign (non-Beaver) handler untouched', async () => {
        const res = await sidebarWidthScenario('restore-leaves-foreign');
        expect(res).toMatchObject({ ok: true, slotIsForeign: true });
    });
});

describe('unwrap helper semantics in the chrome context', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('unwinds tagged chains, resolves legacy wrappers to null, and passes null through', async () => {
        const res = await sidebarWidthScenario('unwrap-direct');
        expect(res).toMatchObject({
            ok: true,
            unwrapsChainToBase: true,
            unwrapsLegacyToNull: true,
            unwrapsNullToNull: true,
        });
    });

    it('rejects unknown scenarios', async () => {
        const res = await sidebarWidthScenario('bogus' as never);
        expect(res.error).toMatch(/unknown scenario/);
    });
});
