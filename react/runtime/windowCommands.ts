import type { TableWindowSurface } from "../atoms/windowSurface";
import {
    currentThreadIdAtom,
    activeRunAtom,
} from "@beaver/agent-core/run-state/atoms";
import { hasComposerDraftAtom } from "../atoms/messageComposition";
import { loadThreadAtom } from "../atoms/threads";
import { userIdAtom } from "../atoms/auth";
import {
    showTableInWindowAtom,
    showThreadInWindowAtom,
} from "../atoms/windowSurface";
import { getHostWindow } from "./windowRuntime";
import { store } from "../store";

/** Commands cross renderer boundaries as persisted ids and plain table data. */
export const windowCommands = {
    "show-table": async (request: {
        surface: Omit<TableWindowSurface, "kind" | "id">;
    }) => {
        store.set(showTableInWindowAtom, request.surface);
        return { ok: true };
    },
    "show-chat": async () => {
        store.set(showThreadInWindowAtom);
        return { ok: true };
    },
    "open-chat": async (request: { threadId: string }) => {
        if (!request.threadId) throw new Error("A persisted chat is required");
        if (store.get(currentThreadIdAtom) !== request.threadId) {
            if (
                store.get(hasComposerDraftAtom) &&
                !getHostWindow().confirm(
                    "Replace the unsent draft in this window and open the requested chat?",
                )
            )
                return { ok: false, canceled: true };
            const loaded = await store.set(loadThreadAtom, {
                threadId: request.threadId,
                user_id: store.get(userIdAtom) ?? "",
                window: getHostWindow(),
            });
            if (!loaded) return { ok: false, canceled: true };
        }
        store.set(showThreadInWindowAtom);
        return { ok: true, activeRunId: store.get(activeRunAtom)?.id ?? null };
    },
};
