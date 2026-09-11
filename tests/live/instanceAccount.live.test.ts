import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { post } from "../helpers/zoteroHttpClient";
import {
    isZoteroAvailable,
    skipIfNoZotero,
} from "../helpers/zoteroAvailability";

const path = "/beaver/test/window-runtime";
interface Projection {
    generation: number;
    revision: number;
    authenticated: boolean;
    profileLoaded: boolean;
    identityMatches: boolean;
    scope: number[];
}
let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});
async function windows() {
    return (
        await post<{ windows: { id: string }[] }>(path, { command: "list" })
    ).windows;
}
const projection = (windowId: string) =>
    post<Projection>(path, { command: "account-state", windowId });

describe.runIf(process.env.BEAVER_MULTI_WINDOW_TEST === "1")(
    "instance account projections in independent Zotero renderers",
    () => {
        beforeEach((ctx) => skipIfNoZotero(ctx, available));
        it("hydrates the same current identity, revision and scope in both bundles", async () => {
            const targets = await windows();
            expect(targets.length).toBeGreaterThanOrEqual(2);
            const first = await projection(targets[0].id);
            expect(first).toMatchObject({
                authenticated: true,
                profileLoaded: true,
                identityMatches: true,
            });
            for (const target of targets.slice(1))
                expect(await projection(target.id)).toEqual(first);
        });
        it("revokes library access in every renderer synchronously and restores it", async () => {
            const targets = await windows();
            const before = await post<any>("/beaver/test/excluded-libraries", {
                action: "get",
            });
            const first = await projection(targets[0].id);
            expect(first.scope.length).toBeGreaterThan(0);
            try {
                await post("/beaver/test/excluded-libraries", {
                    action: "set",
                    exclude_library_ids: first.scope,
                });
                for (const target of targets) {
                    const current = await projection(target.id);
                    expect(current.scope).toEqual([]);
                    expect(current.generation).toBe(first.generation);
                    expect(current.revision).toBeGreaterThan(first.revision);
                }
            } finally {
                await post("/beaver/test/excluded-libraries", {
                    action: "set",
                    excluded_libraries: before.excluded_libraries,
                });
            }
            for (const target of targets)
                expect((await projection(target.id)).scope).toEqual(
                    first.scope,
                );
        });
    },
);
