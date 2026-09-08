// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { atom, createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceService } from "../../../src/services/voice/voiceService";
import {
    FakeVoiceCapture,
    FakeVoiceTranscription,
} from "@beaver/agent-core/voice/fakes";

const mocks = vi.hoisted(() => ({
    prefs: {
        "voice.enabled": true,
        "voice.nativeEnabled": true,
        "voice.language": "en",
    } as Record<string, unknown>,
}));
vi.mock("../../../src/utils/prefs", () => ({
    getPref: (key: string) => mocks.prefs[key],
}));
vi.mock("../../../react/atoms/auth", async () => {
    const { atom } = await import("jotai");
    return { sessionAtom: atom({ user: { id: "user" } }) };
});
vi.mock("../../../react/atoms/profile", async () => {
    const { atom } = await import("jotai");
    return {
        profileWithPlanAtom: atom({ purchased_chat_credits: 5 }),
        searchableLibraryIdsAtom: atom([1]),
    };
});
vi.mock("../../../react/atoms/messageComposition", async () => {
    const { atom } = await import("jotai");
    return { composerResetTokenAtom: atom(0) };
});
vi.mock("../../../react/atoms/zoteroContext", async () => {
    const { atom } = await import("jotai");
    return {
        zoteroContextAtom: atom({
            isLibraryTab: true,
            selectedItems: [],
            libraryView: {
                selectedCollections: [
                    { libraryId: 1, collectionId: 4, collectionName: "Theory" },
                ],
            },
        }),
    };
});
vi.mock("@beaver/agent-core/transport/config", () => ({
    getApiBaseUrl: () => "http://localhost:8000",
}));
vi.mock("@beaver/agent-core/transport/supabaseClient", () => ({
    supabase: {
        auth: {
            getSession: async () => ({
                data: {
                    session: { user: { id: "user" }, access_token: "test" },
                },
            }),
        },
    },
}));
const popupMessages: { title?: string; text?: string }[] = [];
vi.mock("../../../react/utils/popupMessageUtils", async () => {
    const { atom } = await import("jotai");
    return {
        addPopupMessageAtom: atom(
            null,
            (_get, _set, message: { title?: string; text?: string }) => {
                popupMessages.push(message);
            },
        ),
    };
});
import { useComposerVoice } from "../../../react/hooks/useComposerVoice";
import { composerResetTokenAtom } from "../../../react/atoms/messageComposition";
import { searchableLibraryIdsAtom } from "../../../react/atoms/profile";

let service: VoiceService,
    capture: FakeVoiceCapture,
    transcription: FakeVoiceTranscription;
let native: any,
    root: ReturnType<typeof createRoot>,
    container: HTMLElement,
    store: ReturnType<typeof createStore>;
let views: ReturnType<typeof useComposerVoice>[];
let appended: string[][];
let composing = false;
function View({ index }: { index: number }) {
    const input = useRef<HTMLElement | null>(null);
    const editor = useRef<any>({
        appendText: (text: string) => {
            if (composing) return false;
            appended[index].push(text);
            return true;
        },
    });
    views[index] = useComposerVoice(input, editor);
    return React.createElement("div", {
        ref: (element: HTMLDivElement | null) => {
            input.current = element;
            if (element) element.getClientRects = () => [new DOMRect()] as any;
        },
    });
}
const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(async () => {
    vi.useFakeTimers();
    composing = false;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    store = createStore();
    views = [];
    appended = [[], []];
    service = new VoiceService(
        {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (h) => clearTimeout(h as any),
        },
        {
            capability: () => ({ enabled: true, available: true }),
            createCapture: (session, emit) =>
                (capture = new FakeVoiceCapture(session, emit)),
            createTranscription: (session) => {
                transcription = new FakeVoiceTranscription(session);
                transcription.resultText = "Corrected.";
                return transcription;
            },
        },
    );
    native = {
        permission: "granted",
        ensurePackagedHelper: vi.fn(async () => {}),
        prepareMicrophone: vi.fn(async () => "granted"),
    };
    popupMessages.length = 0;
    (Zotero as any).isMac = true;
    (Zotero as any).Beaver = { voice: service, voiceNative: native };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
        root.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(View, { index: 0 }),
                React.createElement(View, { index: 1 }),
            ),
        ),
    );
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    service.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});
async function start() {
    await act(async () => {
        await views[0].toggle();
        await settle();
    });
    expect(service.controller.getSnapshot().phase).toBe("listening");
}
async function finish() {
    await act(async () => {
        for (let i = 0; i < 3; i++) capture.frame();
        await views[0].toggle();
        await settle();
        await vi.advanceTimersByTimeAsync(200);
    });
}
it("blocks all composers during capture and inserts a final result once in its owner", async () => {
    await start();
    expect(views[0].canSend()).toBe(false);
    expect(views[1].canSend()).toBe(false);
    await act(async () => views[1].toggle());
    expect(service.controller.getSnapshot().owner?.output.id).toBeTruthy();
    await finish();
    expect(transcription.requestCount).toBe(1);
    expect(capture.disposed).toBe(true);
    expect(appended).toEqual([["Corrected."], []]);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(appended[0]).toHaveLength(1);
    expect(views[0].canSend()).toBe(true);
});
it("Escape discards capture without transcription or insertion", async () => {
    await start();
    await act(async () => {
        capture.frame();
        globalThis.window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
        );
        await settle();
    });
    expect(service.controller.getSnapshot().phase).toBe("canceled");
    expect(transcription.requestCount).toBe(0);
    expect(capture.disposed).toBe(true);
    expect(appended).toEqual([[], []]);
});
it("requires fresh activation after permission setup", async () => {
    native.permission = "unknown";
    await act(async () => views[0].toggle());
    expect(native.prepareMicrophone).toHaveBeenCalledOnce();
    expect(service.controller.getSnapshot().phase).toBe("idle");
    expect(appended[0]).toEqual([]);
    expect(popupMessages).toEqual([
        {
            type: "info",
            title: "Microphone ready",
            text: "Click the microphone again to record.",
        },
    ]);
});
it("a draft reset cancels capture and prevents later insertion", async () => {
    await start();
    await act(async () => store.set(composerResetTokenAtom, 1));
    expect(capture.disposed).toBe(true);
    expect(service.controller.getSnapshot().phase).toBe("canceled");
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(appended[0]).toEqual([]);
});
it("preserves source eligibility in the shared draft for sends from another composer", async () => {
    await start();
    await finish();
    await act(async () => store.set(searchableLibraryIdsAtom, []));
    await act(async () => expect(views[1].canSend()).toBe(false));
    expect(popupMessages.at(-1)?.text).toContain("Source access changed");
    await act(async () => store.set(composerResetTokenAtom, 1));
    expect(views[1].canSend()).toBe(true);
});
it("canceling unresolved setup prevents late activation and frees the global setup lock", async () => {
    let resolve!: () => void;
    native.ensurePackagedHelper.mockImplementation(
        () => new Promise<void>((r) => (resolve = r)),
    );
    let pending!: Promise<void>;
    await act(async () => {
        pending = views[0].toggle();
    });
    expect(service.preparing).toBe(true);
    expect(views[1].canSend()).toBe(false);
    await act(async () => {
        views[0].cancel();
        resolve();
        await pending;
    });
    expect(service.preparing).toBe(false);
    expect(service.controller.getSnapshot().phase).toBe("idle");
});
it("top-level blur cancels capture and never appends after refocus", async () => {
    await start();
    const target = container.ownerDocument.defaultView!;
    await act(async () => {
        target.dispatchEvent(new FocusEvent("blur"));
        await settle();
    });
    expect(capture.disposed).toBe(true);
    expect(service.controller.getSnapshot().phase).toBe("canceled");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(appended[0]).toEqual([]);
});

it("silence fails before upload and preserves the draft", async () => {
    await start();
    await act(async () => {
        capture.tailSamples = 0;
        for (let i = 0; i < 4; i++) capture.frame(1600, 0);
        await views[0].toggle();
        await settle();
    });
    expect(service.controller.getSnapshot().error?.code).toBe("no_speech");
    expect(transcription.requestCount).toBe(0);
    expect(appended[0]).toEqual([]);
});
it("Escape during finalization ignores a late successful response", async () => {
    await start();
    let resolve!: (value: any) => void;
    transcription.transcribe = vi.fn(() => new Promise((r) => (resolve = r)));
    await act(async () => {
        for (let i = 0; i < 3; i++) capture.frame();
        await views[0].toggle();
        await settle();
    });
    expect(service.controller.getSnapshot().phase).toBe("finalizing");
    const sessionId = service.controller.getSnapshot().sessionId;
    await act(async () => {
        globalThis.window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
        );
        resolve({ version: 1, sessionId, text: "Late text" });
        await settle();
        await vi.advanceTimersByTimeAsync(200);
    });
    expect(service.controller.getSnapshot().phase).toBe("canceled");
    expect(appended[0]).toEqual([]);
});
it("hiding the originating composer cancels capture", async () => {
    await start();
    (container.firstElementChild as HTMLElement).getClientRects = () =>
        [] as any;
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(service.controller.getSnapshot().phase).toBe("canceled");
    expect(capture.disposed).toBe(true);
});
it("permission denial returns recovery text without capture", async () => {
    native.permission = "denied";
    native.prepareMicrophone.mockResolvedValue("denied");
    await act(async () => views[0].toggle());
    expect(service.controller.getSnapshot().phase).toBe("idle");
    expect(popupMessages.at(-1)?.text).toContain("System Settings");
});
it("does not append an empty final result", async () => {
    await start();
    transcription.resultText = "";
    await finish();
    expect(service.controller.getSnapshot().phase).toBe("completed");
    expect(appended[0]).toEqual([]);
});
it("device failure restores the composer and stops capture", async () => {
    await start();
    await act(async () => {
        capture.emit({
            ...capture.session,
            type: "error",
            error: { code: "device_unavailable" },
        });
        await settle();
    });
    expect(service.controller.getSnapshot().phase).toBe("error");
    expect(capture.disposed).toBe(true);
    expect(views[0].canSend()).toBe(true);
    expect(popupMessages.at(-1)?.text).toContain("Connect a microphone");
});

it("shows setup failures in a popup", async () => {
    native.ensurePackagedHelper.mockRejectedValue(
        new Error("Helper unavailable"),
    );
    await act(async () => views[0].toggle());
    expect(popupMessages).toHaveLength(1);
    expect(popupMessages[0].text).toContain("Voice setup failed");
});

it("shows low signal once per recording and only from the owner", async () => {
    await start();
    for (let i = 0; i < 12; i++) {
        await act(async () => {
            capture.frame(1600, 0);
            await settle();
        });
    }
    expect(popupMessages).toHaveLength(1);
    expect(popupMessages[0].text).toContain("Low microphone signal");
    await act(async () => views[0].cancel());
    await start();
    for (let i = 0; i < 10; i++) {
        await act(async () => {
            capture.frame(1600, 0);
            await settle();
        });
    }
    expect(popupMessages).toHaveLength(2);
});

it.each(["EN", "en-x", "abcd", "DE"])(
    "can activate with legacy language %s",
    async (language) => {
        mocks.prefs["voice.language"] = language;
        try {
            await start();
            expect(service.controller.getSnapshot().phase).toBe("listening");
        } finally {
            mocks.prefs["voice.language"] = "en";
        }
    },
);

it("shows clipping once even when quality updates repeat", async () => {
    await start();
    for (let i = 1; i <= 3; i++) {
        await act(async () => {
            capture.emit({
                ...capture.session,
                type: "quality",
                quality: {
                    inputPeak: 1,
                    clippedSamples: i,
                    discontinuityCount: 0,
                },
            });
            await settle();
        });
    }
    expect(popupMessages).toHaveLength(1);
    expect(popupMessages[0].text).toContain("Microphone clipping");
});

it("shows transcription failure recovery once across composers", async () => {
    await start();
    transcription.transcribe = async () => {
        throw new Error("Connection lost");
    };
    await finish();
    expect(popupMessages).toHaveLength(1);
    expect(popupMessages[0].text).toContain("Audio was not retried");
});

async function completeWithoutPolling() {
    await act(async () => {
        for (let i = 0; i < 3; i++) capture.frame();
        await views[0].toggle();
        await settle();
    });
    expect(service.controller.getSnapshot().phase).toBe("completed");
}
it("inserts completed dictation before enabling Send without a timer tick", async () => {
    await start();
    await completeWithoutPolling();
    expect(appended).toEqual([["Corrected."], []]);
    expect(views.every((view) => view.canSend() && !view.busy)).toBe(true);
});
it("blocks every composer while IME delays insertion, then inserts exactly once", async () => {
    await start();
    composing = true;
    await completeWithoutPolling();
    expect(appended).toEqual([[], []]);
    expect(views.every((view) => !view.canSend() && view.busy)).toBe(true);
    const sessionId = service.controller.getSnapshot().sessionId;
    await act(async () => views[1].toggle());
    expect(service.controller.getSnapshot().sessionId).toBe(sessionId);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(views.every((view) => !view.canSend())).toBe(true);
    composing = false;
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(appended).toEqual([["Corrected."], []]);
    expect(views.every((view) => view.canSend() && !view.busy)).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(appended[0]).toHaveLength(1);
});
it.each(["Escape", "reset", "source"])(
    "releases an IME-pending result on %s without later insertion",
    async (reason) => {
        await start();
        composing = true;
        await completeWithoutPolling();
        await act(async () => {
            if (reason === "Escape")
                globalThis.window.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "Escape",
                        cancelable: true,
                    }),
                );
            if (reason === "reset") store.set(composerResetTokenAtom, 1);
            if (reason === "source") {
                store.set(searchableLibraryIdsAtom, []);
                await vi.advanceTimersByTimeAsync(100);
            }
        });
        expect(views.every((view) => view.canSend() && !view.busy)).toBe(true);
        composing = false;
        await act(async () => vi.advanceTimersByTimeAsync(300));
        expect(appended).toEqual([[], []]);
    },
);

it("warns about potentially used credits when the upload outcome is unknown", async () => {
    await start();
    transcription.transcribe = async () => ({
        ...transcription.session,
        error: { code: "outcome_unknown" },
    });
    await finish();
    expect(popupMessages.at(-1)?.text).toContain("may have used credits");
    expect(appended).toEqual([[], []]);
    expect(views.every((view) => view.canSend())).toBe(true);
});
