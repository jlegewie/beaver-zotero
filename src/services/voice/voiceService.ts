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

/** Plugin-realm owner. Production stays unavailable until capture and transport adapters ship. */
export class VoiceService {
    readonly controller: VoiceController;
    private auth?: () => Promise<VoiceAuth | null>;
    private releaseWindow?: () => void;
    private windows = new WeakMap<VoiceWindow, string>();
    private nextWindowId = 0;

    constructor(
        clock: VoiceClock,
        adapters: VoiceAdapters = unavailableAdapters,
    ) {
        this.controller = new VoiceController({
            ...adapters,
            clock,
            createId: () => Zotero.Utilities.randomString(32),
            getAuth: () => this.auth?.() ?? Promise.resolve(null),
        });
        this.controller.subscribe(() => {
            const snapshot = this.controller.getSnapshot();
            if (!isBusyPhase(snapshot.phase)) {
                this.releaseWindow?.();
                this.releaseWindow = undefined;
                this.auth = undefined;
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
    ) {
        if (isBusyPhase(this.controller.getSnapshot().phase)) {
            return { error: { code: "busy" as const } };
        }
        if (!win || win.closed || !win.document.hasFocus())
            return { error: { code: "unavailable" as const } };
        this.auth = getAuth;
        const windowId = this.windowId(win);
        const cancel = () => this.controller.windowUnloaded(windowId);
        win.addEventListener("unload", cancel);
        // Ignore focus moving among controls/reader frames in this top-level window.
        const blur = (event: Event) => {
            if (Object.is(event.target, win)) cancel();
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
            throw error;
        }
        if ("error" in result) {
            this.releaseWindow?.();
            this.releaseWindow = undefined;
            this.auth = undefined;
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
