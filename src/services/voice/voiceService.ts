import { v4 as uuidv4 } from "uuid";
import type { VoiceUploadContext } from "./batchTranscription";
import { VoiceController } from "@beaver/agent-core/voice/controller";
import {
    isBusyPhase,
    type VoiceAuth,
    type VoiceClock,
    type VoiceDependencies,
    type VoiceOwner,
    type VoiceOptions,
} from "@beaver/agent-core/voice/contracts";

export type VoiceWindow = Pick<
    Window,
    "closed" | "addEventListener" | "removeEventListener"
> & {
    document: Pick<Document, "hasFocus">;
};

/** Window proxies can differ by realm; a top-level window still owns the same document. */
export function isVoiceWindowBlur(event: Event, win: VoiceWindow): boolean {
    return (
        Object.is(event.target, win) ||
        (event.target as Window | null)?.document === win.document
    );
}

export type VoiceAdapters = Pick<
    VoiceDependencies,
    "capability" | "createCapture" | "createTranscription"
>;

// The capability gate prevents activation; these factories also fail closed if
// capability is enabled without supplying capture and transcription adapters.
const unavailableAdapters: VoiceAdapters = {
    capability: () => ({ enabled: false, available: false }),
    createCapture: () => {
        throw new Error("Voice capture unavailable");
    },
    createTranscription: () => {
        throw new Error("Voice transcription unavailable");
    },
};

/** Plugin-realm session owner, shared by all mounted views. Activation remains feature-gated. */
export class VoiceService {
    readonly controller: VoiceController;
    uploadContext?: VoiceUploadContext;
    private auth?: () => Promise<VoiceAuth | null>;
    private releaseWindow?: () => void;
    private windows = new WeakMap<VoiceWindow, string>();
    private timing = {
        sessionId: "",
        started: 0,
        ready: 0,
        finishing: 0,
        ended: 0,
    };
    /** Fixed-size, content-free diagnostics for the most recent session; never persisted. */
    diagnostics() {
        const state = this.controller.getSnapshot();
        const t = this.timing;
        return {
            phase: state.phase,
            error: state.error?.code ?? null,
            capturedMs: state.sampleCount / 16,
            frameCount: state.frameCount,
            startupMs: t.ready ? t.ready - t.started : null,
            finishToResultMs:
                t.ended && t.finishing ? t.ended - t.finishing : null,
            quality: { ...state.quality },
        };
    }
    private nextWindowId = 0;
    private nextOutputId = 0;
    createOutputId(): string {
        return `voice-output-${++this.nextOutputId}`;
    }
    private preparation?: symbol;
    private preparationListeners = new Set<() => void>();
    subscribePreparation(listener: () => void): () => void {
        this.preparationListeners.add(listener);
        return () => {
            this.preparationListeners.delete(listener);
        };
    }
    private publishPreparation() {
        for (const listener of this.preparationListeners) listener();
    }
    get preparing(): boolean {
        return !!this.preparation;
    }
    claimPreparation(): (() => void) | null {
        if (this.preparing || isBusyPhase(this.controller.getSnapshot().phase))
            return null;
        const claim = Symbol();
        this.preparation = claim;
        this.publishPreparation();
        return () => {
            if (this.preparation === claim) {
                this.preparation = undefined;
                this.publishPreparation();
            }
        };
    }

    constructor(
        clock: VoiceClock,
        adapters: VoiceAdapters = unavailableAdapters,
    ) {
        this.controller = new VoiceController({
            ...adapters,
            clock,
            createId: () => uuidv4(),
            getAuth: () => this.auth?.() ?? Promise.resolve(null),
        });
        this.controller.subscribe(() => {
            const snapshot = this.controller.getSnapshot();
            const now = Date.now();
            if (
                snapshot.sessionId &&
                snapshot.sessionId !== this.timing.sessionId
            ) {
                this.timing = {
                    sessionId: snapshot.sessionId,
                    started: now,
                    ready: 0,
                    finishing: 0,
                    ended: 0,
                };
            }
            if (snapshot.captureReady && !this.timing.ready)
                this.timing.ready = now;
            if (snapshot.phase === "finalizing" && !this.timing.finishing)
                this.timing.finishing = now;
            if (!isBusyPhase(snapshot.phase) && !this.timing.ended)
                this.timing.ended = now;
            if (!isBusyPhase(snapshot.phase)) {
                this.releaseWindow?.();
                this.releaseWindow = undefined;
                this.auth = undefined;
                this.uploadContext = undefined;
            }
        });
    }

    windowId(win: VoiceWindow): string {
        let id = this.windows.get(win);
        if (!id) {
            id = `voice-window-${++this.nextWindowId}`;
            this.windows.set(win, id);
        }
        return id;
    }

    start(
        win: VoiceWindow | null | undefined,
        output: VoiceOwner["output"],
        getAuth: () => Promise<VoiceAuth | null>,
        expectedUserId: string,
        options?: VoiceOptions,
        uploadContext?: VoiceUploadContext,
    ) {
        if (
            this.preparing ||
            isBusyPhase(this.controller.getSnapshot().phase)
        ) {
            return { error: { code: "busy" as const } };
        }
        if (!win || win.closed || !win.document.hasFocus())
            return { error: { code: "unavailable" as const } };
        this.uploadContext = uploadContext;
        this.auth = getAuth;
        const windowId = this.windowId(win);
        const cancel = () => this.controller.windowUnloaded(windowId);
        win.addEventListener("unload", cancel);
        // Ignore focus moving among controls/reader frames in this top-level window.
        const blur = (event: Event) => {
            if (isVoiceWindowBlur(event, win)) cancel();
        };
        win.addEventListener("blur", blur);
        this.releaseWindow = () => {
            win.removeEventListener("unload", cancel);
            win.removeEventListener("blur", blur);
        };
        let result;
        try {
            result = this.controller.start(
                { windowId, output },
                expectedUserId,
                options,
            );
        } catch (error) {
            this.releaseWindow?.();
            this.releaseWindow = undefined;
            this.auth = undefined;
            this.uploadContext = undefined;
            throw error;
        }
        if ("error" in result) {
            this.releaseWindow?.();
            this.releaseWindow = undefined;
            this.auth = undefined;
            this.uploadContext = undefined;
        }
        return result;
    }

    windowUnloaded(win: VoiceWindow): void {
        const id = this.windows.get(win);
        if (id) this.controller.windowUnloaded(id);
    }
    authChanged(userId: string | null): void {
        this.controller.authChanged(userId);
    }
    dispose(): void {
        this.preparation = undefined;
        this.publishPreparation();
        this.preparationListeners.clear();
        this.controller.dispose();
    }
}

export function systemClock(): VoiceClock {
    const timers = ChromeUtils.importESModule(
        "resource://gre/modules/Timer.sys.mjs",
    );
    return {
        setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
        clearTimeout: (handle) => timers.clearTimeout(handle),
    };
}

export function createVoiceService(
    adapters?: VoiceAdapters,
    clock: VoiceClock = systemClock(),
): VoiceService {
    return new VoiceService(clock, adapters);
}
