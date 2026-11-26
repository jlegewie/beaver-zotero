import { isThreadListViewAtom } from "../atoms/ui";
import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import { searchableLibraryIdsAtom } from "../atoms/profile";
import { eventManager } from "../events/eventManager";

import {
    currentThreadIdAtom,
    activeRunAtom,
} from "@beaver/agent-core/run-state/atoms";
import {
    addItemToCurrentMessageItemsAtom,
    composerDraftAtom,
    hasComposerDraftAtom,
} from "../atoms/messageComposition";
import { loadThreadAtom, threadNavigationSeqAtom } from "../atoms/threads";
import { userIdAtom } from "../atoms/auth";
import { getHostWindow } from "./windowRuntime";
import { store } from "../store";

/** Resolve presentation waits on unload too: a closed window cannot fire its timers. */
function waitForSurface(win: Window, delay: number): Promise<void> {
    return new Promise((resolve) => {
        if (win.closed) return resolve();
        const done = () => {
            win.clearTimeout(timer);
            win.removeEventListener("unload", done);
            resolve();
        };
        win.addEventListener("unload", done, { once: true });
        const timer = win.setTimeout(done, delay);
    });
}

/** Commands cross renderer boundaries as persisted ids. */
export const windowCommands = {
    /**
     * Opens this window's chat with a stored table attached: "Ask Beaver"
     * from a table in its own window, which has no chat. A table in an
     * excluded library opens the chat without it.
     */
    "ask-about-table": async (request: { libraryID: number; key: string }) => {
        const win = getHostWindow();
        const item = Number.isInteger(request?.libraryID) && request?.key
            ? await Zotero.Items.getByLibraryAndKeyAsync(request.libraryID, request.key)
            : false;
        if (win.closed || win.__beaverRuntime?.status === "closing") return { ok: false, canceled: true };
        win.focus();
        // Only the table: the library selection is not part of this question.
        eventManager.dispatch("toggleChat", { forceOpen: true, skipAutoPopulate: true });
        // The chat history would cover the chat and its composer.
        store.set(isThreadListViewAtom, false);
        const attached = !!item && store.get(searchableLibraryIdsAtom).includes(item.libraryID);
        if (attached) await store.set(addItemToCurrentMessageItemsAtom, item);
        // The composer focus handler defers focus until its surface has mounted.
        win.setTimeout(() => eventManager.dispatch("focusInput", {}), 0);
        return { ok: true, attached };
    },

    "open-chat": async (request: { threadId: string }) => {
        if (!request.threadId) throw new Error("A persisted chat is required");
        const win = getHostWindow();
        const generation = getCredentialGeneration();
        const navigation = store.get(threadNavigationSeqAtom);
        const destination = store.get(currentThreadIdAtom);
        const sameChat = destination === request.threadId;
        let draftEdited = false;
        const unsubscribe = store.sub(composerDraftAtom, () => {
            draftEdited = true;
        });
        try {
            const current = () =>
                !win.closed &&
                win.__beaverRuntime?.status !== "closing" &&
                generation === getCredentialGeneration() &&
                navigation === store.get(threadNavigationSeqAtom) &&
                destination === store.get(currentThreadIdAtom);

            win.focus();
            store.set(isThreadListViewAtom, false);
            // Let the thread view replace the list and reveal the composer before the native prompt.
            await waitForSurface(win, 0);
            if (!current()) return { ok: false, canceled: true };
            eventManager.dispatch("focusInput", {});
            const draftUnchanged = () => !draftEdited;
            if (!sameChat && !draftUnchanged())
                return { ok: false, canceled: true };
            if (!sameChat && store.get(hasComposerDraftAtom)) {
                // The composer focus handler defers focus until its surface has mounted.
                await waitForSurface(win, 75);
                if (!current() || !draftUnchanged())
                    return { ok: false, canceled: true };
                const choice = Zotero.Prompt.confirm({
                    window: win,
                    title: "Open chat",
                    text: "Discard the draft in the Beaver window and open this chat?",
                    button0: "Discard draft and open",
                    button1: "Cancel",
                    defaultButton: 1,
                });
                if (choice !== 0) return { ok: false, canceled: true };
            }
            // A response going in this window's chat, or in the one opened,
            // goes on: the window shows the opened chat's session.
            const canCommit = () => current() && (sameChat || draftUnchanged());
            if (!canCommit()) return { ok: false, canceled: true };
            const loaded = await store.set(loadThreadAtom, {
                threadId: request.threadId,
                user_id: store.get(userIdAtom) ?? "",
                window: win,
                canCommit,
                preserveDraft: sameChat,
            });
            return loaded
                ? { ok: true, activeRunId: store.get(activeRunAtom)?.id ?? null }
                : { ok: false, canceled: true };
        } finally {
            unsubscribe();
        }
    },

    /**
     * Opens a chat in this main window's sidebar: a notification of a run no
     * window shows was clicked.
     */
    "show-chat": async (request: { threadId: string }) => {
        if (!request.threadId) throw new Error("A persisted chat is required");
        const win = getHostWindow();
        if (win.closed || win.__beaverRuntime?.status === "closing") return { ok: false, canceled: true };
        win.focus();
        eventManager.dispatch("toggleChat", { forceOpen: true });
        store.set(isThreadListViewAtom, false);
        if (store.get(currentThreadIdAtom) === request.threadId) return { ok: true };
        const loaded = await store.set(loadThreadAtom, {
            threadId: request.threadId,
            user_id: store.get(userIdAtom) ?? "",
            window: win,
            preserveDraft: true,
        });
        return { ok: loaded };
    },
};
