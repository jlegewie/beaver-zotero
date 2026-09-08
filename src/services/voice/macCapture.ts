import {
    VOICE_FORMAT,
    VOICE_LIMITS,
    VOICE_VERSION,
    type CaptureEvent,
    type VoiceCapture,
    type VoiceClock,
    type VoiceEnvelope,
    type VoiceErrorCode,
} from "@beaver/agent-core/voice/contracts";
import type { VoiceHttpRequest, VoiceHttpResponse } from "./voiceHttp";

export const MAC_VOICE_LIMITS = {
    heartbeatMs: 500,
    contactMs: 3000,
    stallMs: 3000,
} as const;
export type MicrophonePermission =
    | "unknown"
    | "not_determined"
    | "granted"
    | "denied"
    | "restricted";
export interface MacCaptureHost {
    clock: VoiceClock;
    now(): number;
    token(): string;
    launch(
        port: number,
        token: string,
        sessionId: string,
        permissionOnly: boolean,
    ): Promise<void>;
    decode(base64: string): Uint8Array;
}
function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    // Disposal can precede a caller awaiting setup or finish.
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
const nativeErrors = new Set<VoiceErrorCode>([
    "permission_denied",
    "device_unavailable",
    "capture_failed",
    "discontinuity",
    "disconnected",
    "protocol_error",
    "overflow",
    "startup_timeout",
    "finalization_timeout",
    "duration_limit",
    "unavailable",
]);

/** Owns the single native capture lease; authorization is revoked synchronously on disposal. */
export class MacCaptureService {
    private active?: MacCapture;
    private disposed = false;
    permission: MicrophonePermission = "unknown";
    constructor(
        private readonly host: MacCaptureHost,
        readonly port: number,
    ) {}

    createCapture(
        session: VoiceEnvelope,
        emit: (event: CaptureEvent) => void,
    ): VoiceCapture {
        return this.create(session, emit, false);
    }

    /** A setup-only lease: no ready/frame event is accepted and no controller is activated. */
    preparePermission(
        session: VoiceEnvelope,
    ): Pick<VoiceCapture, "start" | "dispose"> {
        return this.create(session, () => {}, true);
    }

    private create(
        session: VoiceEnvelope,
        emit: (event: CaptureEvent) => void,
        permissionOnly: boolean,
    ): VoiceCapture {
        if (this.disposed || this.active)
            throw new Error("Native capture unavailable");
        const capture = new MacCapture(
            this.host,
            this.port,
            session,
            emit,
            () => {
                if (this.active === capture) this.active = undefined;
            },
            (permission) => {
                this.permission = permission;
            },
            permissionOnly,
        );
        this.active = capture;
        return capture;
    }

    handle(request: VoiceHttpRequest): VoiceHttpResponse {
        const active = this.active;
        if (
            !active ||
            request.headers.authorization !== `Bearer ${active.token}`
        )
            return { status: 403, body: { command: "cancel" } };
        try {
            const message = JSON.parse(request.body);
            return active.receive(message);
        } catch {
            active.fail("protocol_error");
            return { status: 400, body: { command: "cancel" } };
        }
    }
    dispose(): void {
        this.disposed = true;
        this.active?.dispose();
    }
}

class MacCapture implements VoiceCapture {
    readonly token: string;
    private started = false;
    private dead = false;
    private ready = false;
    private hello = false;
    private stopping = false;
    private tail = false;
    private sequence = 0;
    private sampleCount = 0;
    private controlSequence = 0;
    private eventSequence = 0;
    private timer?: unknown;
    private startTime = 0;
    private readyTime = 0;
    private lastFrame = 0;
    private lastControl = 0;
    private stopTime = 0;
    private setup = deferred();
    private done = deferred();

    constructor(
        private readonly host: MacCaptureHost,
        private readonly port: number,
        private readonly session: VoiceEnvelope,
        private readonly emit: (event: CaptureEvent) => void,
        private readonly release: () => void,
        private readonly permission: (value: MicrophonePermission) => void,
        private readonly permissionOnly: boolean,
    ) {
        this.token = host.token();
    }
    start(): Promise<void> {
        if (this.dead) return this.setup.promise;
        if (!this.started) {
            this.started = true;
            this.startTime = this.lastControl = this.host.now();
            this.watch();
            void this.host
                .launch(
                    this.port,
                    this.token,
                    this.session.sessionId,
                    this.permissionOnly,
                )
                .catch(() => this.fail("unavailable"));
        }
        return this.setup.promise;
    }
    finish(): Promise<void> {
        if (!this.dead && !this.stopping) {
            if (!this.ready) {
                this.dispose();
                return this.done.promise;
            }
            this.stopping = true;
            this.stopTime = this.host.now();
        }
        return this.done.promise;
    }
    dispose(): void {
        if (this.dead) return;
        this.dead = true;
        if (this.timer !== undefined) this.host.clock.clearTimeout(this.timer);
        this.release();
        this.setup.reject(new Error("Capture disposed"));
        this.done.reject(new Error("Capture disposed"));
    }
    fail(code: VoiceErrorCode): void {
        if (this.dead) return;
        // Revoke before invoking user code (which may start another session).
        this.dispose();
        this.emit({ ...this.session, type: "error", error: { code } });
    }
    private watch(): void {
        this.timer = this.host.clock.setTimeout(() => {
            if (this.dead) return;
            const now = this.host.now();
            if (!this.ready && now - this.startTime >= VOICE_LIMITS.startupMs)
                this.fail("startup_timeout");
            else if (
                this.stopping &&
                now - this.stopTime >= VOICE_LIMITS.finalizationMs
            )
                this.fail("finalization_timeout");
            else if (
                this.hello &&
                now - this.lastControl >= MAC_VOICE_LIMITS.contactMs
            )
                this.fail("disconnected");
            else if (
                this.ready &&
                !this.stopping &&
                now - this.lastFrame >= MAC_VOICE_LIMITS.stallMs
            )
                this.fail("capture_failed");
            else if (
                this.ready &&
                now - this.readyTime >= VOICE_LIMITS.durationMs
            )
                this.fail("duration_limit");
            if (!this.dead) this.watch();
        }, MAC_VOICE_LIMITS.heartbeatMs);
    }
    receive(m: any): VoiceHttpResponse {
        if (this.dead || !this.started)
            return { status: 403, body: { command: "cancel" } };
        if (
            !m ||
            m.version !== VOICE_VERSION ||
            m.sessionId !== this.session.sessionId
        )
            throw new Error("envelope");
        if (m.type === "control") {
            if (!this.hello || m.sequence !== this.controlSequence++)
                throw new Error("control_order");
            this.lastControl = this.host.now();
        } else {
            if (m.eventSequence !== this.eventSequence++)
                throw new Error("event_order");
            switch (m.type) {
                case "hello":
                    if (this.hello || m.helperVersion !== 1)
                        throw new Error("hello");
                    this.hello = true;
                    this.lastControl = this.host.now();
                    break;
                case "permission":
                    if (
                        !this.hello ||
                        this.ready ||
                        ![
                            "not_determined",
                            "granted",
                            "denied",
                            "restricted",
                        ].includes(m.status)
                    )
                        throw new Error("permission");
                    this.permission(m.status);
                    break;
                case "permission_done":
                    if (
                        !this.permissionOnly ||
                        !this.hello ||
                        !["granted", "denied", "restricted"].includes(m.status)
                    )
                        throw new Error("permission_done");
                    this.permission(m.status);
                    this.setup.resolve();
                    this.done.resolve();
                    this.dispose();
                    return {
                        status: 200,
                        body: { ...this.session, command: "exit" },
                    };
                case "ready":
                    if (
                        this.permissionOnly ||
                        !this.hello ||
                        this.ready ||
                        m.format?.sampleRate !== 16000 ||
                        m.format?.channels !== 1 ||
                        m.format?.encoding !== "pcm_s16le"
                    )
                        throw new Error("ready");
                    this.ready = true;
                    this.readyTime = this.lastFrame = this.host.now();
                    this.emit({
                        ...this.session,
                        type: "ready",
                        format: VOICE_FORMAT,
                    });
                    this.setup.resolve();
                    break;
                case "frame": {
                    if (
                        !this.ready ||
                        this.tail ||
                        m.sequence !== this.sequence ||
                        !Number.isInteger(m.sampleCount) ||
                        m.sampleCount <= 0 ||
                        m.sampleCount > VOICE_LIMITS.frameSamples ||
                        (m.sampleCount < VOICE_LIMITS.frameSamples &&
                            !this.stopping) ||
                        typeof m.pcm !== "string" ||
                        m.pcm.length !==
                            4 * Math.ceil((m.sampleCount * 2) / 3) ||
                        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                            m.pcm,
                        )
                    )
                        throw new Error("frame");
                    const pcm = this.host.decode(m.pcm);
                    if (pcm.length !== m.sampleCount * 2)
                        throw new Error("pcm");
                    this.tail = m.sampleCount < VOICE_LIMITS.frameSamples;
                    this.sequence++;
                    this.sampleCount += m.sampleCount;
                    this.lastFrame = this.host.now();
                    this.emit({
                        ...this.session,
                        type: "frame",
                        frame: {
                            ...this.session,
                            sequence: m.sequence,
                            sampleCount: m.sampleCount,
                            format: VOICE_FORMAT,
                            pcm,
                        },
                    });
                    break;
                }
                case "done":
                    if (
                        !this.stopping ||
                        m.frameCount !== this.sequence ||
                        m.sampleCount !== this.sampleCount
                    )
                        throw new Error("done");
                    this.done.resolve();
                    this.dispose();
                    return {
                        status: 200,
                        body: { ...this.session, command: "exit" },
                    };
                case "error":
                    if (!nativeErrors.has(m.code)) throw new Error("error");
                    this.fail(m.code);
                    break;
                default:
                    throw new Error("event");
            }
        }
        return {
            status: 200,
            body: {
                ...this.session,
                command: this.dead
                    ? "cancel"
                    : this.stopping
                      ? "finish"
                      : "continue",
            },
        };
    }
}
