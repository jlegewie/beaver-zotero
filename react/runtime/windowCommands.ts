import { isThreadListViewAtom } from "../atoms/ui";
import { isRunActive } from "@beaver/agent-core/agents/types";
import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import { atom, type Getter } from "jotai";
import { isWSChatPendingAtom } from "../atoms/agentRunAtoms";
import { accountGenerationAtom } from "../atoms/profile";
import { threadAdmissionAtom, type AdmissionSnapshot } from "./threadAdmission";
import { threadPresenceAtom } from "./threadProjection";
import { currentWriter } from "./threadWriter";
import { eventManager } from "../events/eventManager";
import {
    hasThreadWriter,
    isFinishedChat,
    RESPONSE_FINISH_MESSAGE,
} from "../../src/services/threads/finishedChat";

import type { TableWindowSurface } from "../atoms/windowSurface";
import {
    currentThreadIdAtom,
    activeRunAtom,
} from "@beaver/agent-core/run-state/atoms";
import {
    composerDraftAtom,
    hasComposerDraftAtom,
} from "../atoms/messageComposition";
import { loadThreadAtom, threadNavigationSeqAtom } from "../atoms/threads";
import { userIdAtom } from "../atoms/auth";
import {
    showTableInWindowAtom,
    showThreadInWindowAtom,
} from "../atoms/windowSurface";
import { getHostWindow } from "./windowRuntime";
import { store } from "../store";

interface FinishedChatAvailability {
    threadId: string;
    generation: number;
    navigation: number;
    admission: AdmissionSnapshot | null;
    finished: boolean;
}

// Menu reads never advance the tail used to admit a send against displayed history.
const finishedChatAvailabilityAtom = atom<FinishedChatAvailability | null>(
    null,
);

function isAvailabilityCurrent(
    get: Getter,
    value: FinishedChatAvailability,
): boolean {
    return (
        value.threadId === get(currentThreadIdAtom) &&
        value.generation === get(accountGenerationAtom) &&
        value.navigation === get(threadNavigationSeqAtom) &&
        value.admission === get(threadAdmissionAtom)
    );
}

export const refreshFinishedChatAvailabilityAtom = atom(
    null,
    async (get, set) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) return;
        const credentials = getCredentialGeneration();
        const pending: FinishedChatAvailability = {
            threadId,
            generation: get(accountGenerationAtom),
            navigation: get(threadNavigationSeqAtom),
            admission: get(threadAdmissionAtom),
            finished: false,
        };
        set(finishedChatAvailabilityAtom, pending);
        const finished = await isFinishedChat(threadId);
        if (
            get(finishedChatAvailabilityAtom) !== pending ||
            credentials !== getCredentialGeneration() ||
            !isAvailabilityCurrent(get, pending)
        )
            return;
        set(finishedChatAvailabilityAtom, { ...pending, finished });
    },
);

export const canOpenFinishedChatAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    const admission = get(threadAdmissionAtom);
    const availability = get(finishedChatAvailabilityAtom);
    const finished =
        availability && isAvailabilityCurrent(get, availability)
            ? availability.finished
            : admission?.threadId === id && admission.activity.state === "idle";
    return (
        !!id &&
        !get(isWSChatPendingAtom) &&
        !isRunActive(get(activeRunAtom)) &&
        !get(threadPresenceAtom).claims.some(
            (claim) => claim.threadId === id,
        ) &&
        finished
    );
});

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
            const destinationBusy = () =>
                !!currentWriter() ||
                store.get(isWSChatPendingAtom) ||
                isRunActive(store.get(activeRunAtom)) ||
                (destination !== null &&
                    (hasThreadWriter(destination) ||
                        (store.get(threadAdmissionAtom)?.threadId ===
                            destination &&
                            ["active", "unknown"].includes(
                                store.get(threadAdmissionAtom)!.activity.state,
                            ))));
            const decline = (message: string) => {
                win.focus();
                win.alert(message);
                return { ok: false, canceled: true };
            };
            if (!sameChat && destinationBusy())
                return decline(
                    "The Beaver window is responding to another chat. Try again when it finishes.",
                );
            const finished = await isFinishedChat(request.threadId);
            if (!current()) return { ok: false, canceled: true };
            if (!finished) return decline(RESPONSE_FINISH_MESSAGE);
            if (destinationBusy())
                return decline(
                    sameChat
                        ? RESPONSE_FINISH_MESSAGE
                        : "The Beaver window is responding to another chat. Try again when it finishes.",
                );

            win.focus();
            store.set(showThreadInWindowAtom);
            store.set(isThreadListViewAtom, false);
            // Let a table surface unmount and reveal the composer before the native prompt.
            await waitForSurface(win, 0);
            if (!current() || destinationBusy())
                return { ok: false, canceled: true };
            eventManager.dispatch("focusInput", {});
            const draftUnchanged = () => !draftEdited;
            if (!sameChat && !draftUnchanged())
                return { ok: false, canceled: true };
            if (!sameChat && store.get(hasComposerDraftAtom)) {
                // The composer focus handler defers focus until its surface has mounted.
                await waitForSurface(win, 75);
                if (!current() || destinationBusy() || !draftUnchanged())
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
            const canCommit = () =>
                current() &&
                !destinationBusy() &&
                !hasThreadWriter(request.threadId) &&
                (sameChat || draftUnchanged());
            if (!canCommit()) return { ok: false, canceled: true };
            const loaded = await store.set(loadThreadAtom, {
                threadId: request.threadId,
                user_id: store.get(userIdAtom) ?? "",
                window: win,
                canCommit,
                preserveDraft: sameChat,
            });
            return loaded
                ? { ok: true, activeRunId: null }
                : { ok: false, canceled: true };
        } finally {
            unsubscribe();
        }
    },
};
