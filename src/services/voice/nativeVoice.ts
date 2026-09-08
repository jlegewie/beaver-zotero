import type {
    CaptureEvent,
    VoiceEnvelope,
    VoiceErrorCode,
} from "@beaver/agent-core/voice/contracts";
import { getPref, setPref } from "../../utils/prefs";
import { MacCaptureService } from "./macCapture";
import { VoiceSocket } from "./voiceSocket";
import { systemClock } from "./voiceService";

/** Native resources live in the plugin realm, independently of React and login state. */
export class NativeVoice {
    private capture?: MacCaptureService;
    private socket?: VoiceSocket;
    private helperPath?: string;
    private disposed = false;

    private initialize(): void {
        if (this.capture) return;
        const clock = systemClock();
        const socket = new VoiceSocket(clock, (request) =>
            this.capture!.handle(request),
        );
        try {
            this.capture = new MacCaptureService(
                {
                    clock,
                    now: () => Cu.now(),
                    token: () => {
                        const random = Cc[
                            "@mozilla.org/security/random-generator;1"
                        ].createInstance(Ci.nsIRandomGenerator);
                        return Array.from(
                            random.generateRandomBytes(32),
                            (byte) => byte.toString(16).padStart(2, "0"),
                        ).join("");
                    },
                    decode: (encoded) => {
                        const binary = atob(encoded);
                        return Uint8Array.from(binary, (c) => c.charCodeAt(0));
                    },
                    launch: async (port, token, sessionId, permissionOnly) => {
                        const path = this.helperPath;
                        if (!path || this.disposed)
                            throw new Error("Native helper unavailable");
                        const { Subprocess } = ChromeUtils.importESModule(
                            "resource://gre/modules/Subprocess.sys.mjs",
                        );
                        const child = await Subprocess.call({
                            command: "/usr/bin/open",
                            arguments: [
                                "-n",
                                "-g",
                                path,
                                "--args",
                                "--port",
                                String(port),
                                "--token",
                                token,
                                "--session",
                                sessionId,
                                ...(permissionOnly
                                    ? ["--permission-only"]
                                    : []),
                            ],
                            stderr: "pipe",
                        });
                        const result = await child.wait();
                        if (result.exitCode !== 0)
                            throw new Error("Helper launch failed");
                    },
                },
                socket.port,
            );
            this.socket = socket;
        } catch (error) {
            socket.dispose();
            throw error;
        }
    }

    /** Local development placement only. Packaged artifact verification is a separate installer responsibility. */
    async setDevelopmentHelper(path: string): Promise<void> {
        if (
            __env__ !== "development" ||
            this.disposed ||
            !path.startsWith("/") ||
            !path.endsWith(".app")
        ) {
            throw new Error("Development helper unavailable");
        }
        const { Subprocess } = ChromeUtils.importESModule(
            "resource://gre/modules/Subprocess.sys.mjs",
        );
        const child = await Subprocess.call({
            command: "/usr/bin/codesign",
            arguments: ["--verify", "--strict", path],
            stderr: "pipe",
        });
        if ((await child.wait()).exitCode !== 0 || this.disposed)
            throw new Error("Helper verification failed");
        this.initialize();
        // A verified path may contain a rebuilt/re-signed app with different OS permission state.
        this.capture!.permission = "unknown";
        this.helperPath = path;
    }
    get available(): boolean {
        return (
            !this.disposed &&
            !!this.helperPath &&
            !!this.capture &&
            Zotero.isMac
        );
    }
    get permission() {
        return this.capture?.permission ?? "unknown";
    }
    createCapture(session: VoiceEnvelope, emit: (event: CaptureEvent) => void) {
        if (!this.available) throw new Error("Native helper unavailable");
        return this.capture!.createCapture(session, emit);
    }
    explain(win: Window): boolean {
        if (getPref("voice.helperExplained")) return true;
        const accepted = Services.prompt.confirm(
            win as Window & nsISupports,
            "Beaver Voice Input",
            "Beaver uses a companion app named Beaver Voice Input to access your microphone. macOS will show that name in its permission prompt and microphone indicator. Permission setup does not record audio; start again afterward.",
        );
        if (accepted) setPref("voice.helperExplained", true);
        return accepted;
    }
    /** Permission setup tolerates focus transfer but is canceled on owner unload or shutdown. */
    async prepareMicrophone(win: Window) {
        if (!this.available || !win || win.closed || !this.explain(win))
            return "unknown" as const;
        const capture = this.capture!.preparePermission({
            version: 1,
            sessionId: Zotero.Utilities.randomString(32),
        });
        const cancel = () => capture.dispose();
        win.addEventListener("unload", cancel);
        try {
            await capture.start();
            return this.capture?.permission ?? "unknown";
        } finally {
            win.removeEventListener("unload", cancel);
            capture.dispose();
        }
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        try {
            this.capture?.dispose();
        } finally {
            this.socket?.dispose();
        }
    }
}

export function microphoneHelp(code: VoiceErrorCode): string {
    if (code === "permission_denied")
        return "Allow Beaver Voice Input in System Settings → Privacy & Security → Microphone, then start again.";
    if (code === "device_unavailable")
        return "Connect or enable a microphone in System Settings → Sound → Input, then start again.";
    if (code === "unavailable")
        return "If you just granted microphone permission, start again. Otherwise check that the Beaver Voice Input helper is installed.";
    return "Recording stopped. Check your microphone connection and start again.";
}
