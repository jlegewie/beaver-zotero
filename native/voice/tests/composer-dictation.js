// Synthetic capture and local-only upload; restores all temporary host overrides.
const w = VOICE_TEST_WINDOW,
    doc = w.document,
    service = Zotero.Beaver.voice,
    native = Zotero.Beaver.voiceNative;
const timers = ChromeUtils.importESModule(
        "resource://gre/modules/Timer.sys.mjs",
    ),
    wait = (ms) => new Promise((r) => timers.setTimeout(r, ms));
Zotero.Beaver.voiceHarness.run({ command: "enable", enabled: false });
await native.ensurePackagedHelper();

await wait(300);
const input = doc.querySelector(`${VOICE_TEST_ROOT} .beaver-lexical-content`);
if (!input) throw new Error("No mounted composer");
const editor = input.__lexicalEditor;
if (!editor) throw new Error("No Lexical editor");
const originalState = editor.getEditorState(),
    originalCompositionKey = editor._compositionKey,
    originalStart = service.start,
    originalCapture = service.controller.deps.createCapture;
const focusDescriptor = Object.getOwnPropertyDescriptor(doc, "hasFocus");
const permissionDescriptor = Object.getOwnPropertyDescriptor(
    native,
    "permission",
);
const originalEnsure = native.ensurePackagedHelper;
let feed,
    failCapture,
    warnClipping,
    disposed = false,
    sequence = 0,
    requestsBefore = (await (await w.fetch(VOICE_TEST_URL)).json()).requests;
const checks = [];
const check = (condition, label) => {
    checks.push({ label, passed: !!condition });
    if (!condition) throw new Error(label);
};
const write = (text) =>
    editor.update(
        () => {
            const root = editor.getEditorState()._nodeMap.get("root");
            root.clear();
            const p = new (editor._nodes.get("paragraph").klass)();
            p.append(new (editor._nodes.get("text").klass)(text));
            root.append(p);
            p.selectEnd();
        },
        { discrete: true },
    );
try {
    Object.defineProperty(doc, "hasFocus", {
        configurable: true,
        value: () => true,
    });
    Object.defineProperty(native, "permission", {
        configurable: true,
        value: "granted",
    });
    native.ensurePackagedHelper = async () => {};
    service.start = function (win, output, auth, user, options, upload) {
        return originalStart.call(
            this,
            win,
            output,
            async () => ({ userId: user, credential: "voice-local-wire-test" }),
            user,
            options,
            { ...upload, baseUrl: VOICE_TEST_URL },
        );
    };
    service.controller.deps.createCapture = (session, emit) => {
        disposed = false;
        sequence = 0;
        failCapture = () =>
            emit({
                ...session,
                type: "error",
                error: { code: "device_unavailable" },
            });
        warnClipping = () =>
            emit({
                ...session,
                type: "quality",
                quality: {
                    inputPeak: 1,
                    clippedSamples: 1,
                    discontinuityCount: 0,
                },
            });
        feed = (samples = 1600) => {
            if (disposed) return;
            const pcm = new Uint8Array(samples * 2),
                view = new DataView(pcm.buffer);
            for (let i = 0; i < samples; i++)
                view.setInt16(
                    i * 2,
                    Math.round(
                        Math.sin((2 * Math.PI * 440 * i) / 16000) * 6000,
                    ),
                    true,
                );
            emit({
                ...session,
                type: "frame",
                frame: {
                    ...session,
                    sequence: sequence++,
                    sampleCount: samples,
                    format: {
                        encoding: "pcm_s16le",
                        sampleRate: 16000,
                        channels: 1,
                    },
                    pcm,
                },
            });
        };
        return {
            start: async () =>
                emit({
                    ...session,
                    type: "ready",
                    format: {
                        encoding: "pcm_s16le",
                        sampleRate: 16000,
                        channels: 1,
                    },
                }),
            finish: async () => feed(640),
            dispose: () => {
                disposed = true;
            },
        };
    };
    write("Existing draft.");
    await wait(100);
    doc.querySelector(
        `${VOICE_TEST_ROOT} button[aria-label="Dictate message"]`,
    ).click();
    await wait(300);
    check(
        service.controller.getSnapshot().phase === "listening",
        "Mic click starts listening",
    );
    check(
        doc.querySelectorAll(".composer-voice-bars > span").length === 0,
        "Graph starts empty",
    );
    for (let i = 0; i < 15; i++) {
        feed();
        await wait(12);
    }
    write("Existing draft. Typed during capture.");
    await wait(100);
    const buttons = Array.from(
        doc.querySelectorAll(`${VOICE_TEST_ROOT} button`),
    );
    check(
        !buttons.some((b) => b.getAttribute("aria-label") === "Web search"),
        "Web search hidden",
    );
    check(
        !buttons.some((b) =>
            (b.getAttribute("aria-label") || "").startsWith("AI model:"),
        ),
        "Model picker hidden",
    );
    check(
        buttons.find((b) => b.getAttribute("aria-label") === "Add Sources")
            ?.disabled,
        "Add Sources stays visible and disabled",
    );
    check(
        buttons.find((b) => b.getAttribute("aria-label") === "Send message")
            ?.disabled,
        "Send stays visible and disabled",
    );
    check(
        doc.querySelector(".composer-voice-time")?.textContent === "0:01",
        "Elapsed timer follows captured samples",
    );
    check(
        w.getComputedStyle(doc.querySelector(".composer-voice-bars"))
            .justifyContent === "flex-end",
        "Graph grows from the right",
    );
    const rect = input.closest("form").getBoundingClientRect();
    const canvas = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas",
    );
    canvas.width = Math.ceil(rect.width * 2);
    canvas.height = Math.ceil(rect.height * 2);
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.drawWindow(w, rect.x, rect.y, rect.width, rect.height, "white");
    await IOUtils.write(
        VOICE_SCREENSHOT,
        Uint8Array.from(
            w.atob(canvas.toDataURL("image/png").split(",")[1]),
            (c) => c.charCodeAt(0),
        ),
    );
    editor._compositionKey = "voice-test-composition";
    doc.querySelector(
        'button[aria-label="Stop dictation and transcribe"]',
    ).click();
    await wait(900);
    check(
        service.controller.getSnapshot().phase === "completed",
        "Stop returns final result",
    );
    check(
        !input.textContent.includes("Corrected local wire test."),
        "IME delays insertion of the completed result",
    );
    check(
        doc.querySelector(
            `${VOICE_TEST_ROOT} button[aria-label="Send message"]`,
        )?.disabled,
        "Send remains disabled while the completed result awaits IME",
    );
    editor._compositionKey = originalCompositionKey;
    await wait(200);
    check(
        !doc.querySelector(
            `${VOICE_TEST_ROOT} button[aria-label="Send message"]`,
        )?.disabled,
        "Send is restored after the result is inserted",
    );
    check(
        input.textContent ===
            "Existing draft. Typed during capture. Corrected local wire test.",
        "Appends after concurrent typing",
    );
    await wait(300);
    check(
        input.textContent.split("Corrected local wire test.").length === 2,
        "No duplicate insertion",
    );
    check(disposed, "Capture released after Stop");
    const afterStop = (await (await w.fetch(VOICE_TEST_URL)).json()).requests;
    check(afterStop === requestsBefore + 1, "Stop makes exactly one POST");
    doc.querySelector('button[aria-label="Dictate message"]').click();
    await wait(200);
    feed();
    feed();
    feed();
    w.dispatchEvent(
        new w.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    await wait(300);
    check(
        service.controller.getSnapshot().phase === "canceled",
        "Escape cancels listening",
    );
    check(disposed, "Escape releases capture");
    check(
        (await (await w.fetch(VOICE_TEST_URL)).json()).requests === afterStop,
        "Escape makes no POST",
    );
    editor.setEditorState(originalState);
    await wait(100);
    doc.querySelector('button[aria-label="Dictate message"]').click();
    await wait(250);
    warnClipping();
    await wait(200);
    check(
        doc
            .querySelector(VOICE_TEST_ROOT)
            .textContent.includes("Microphone clipping — speak more softly"),
        "Clipping recovery popup is visible",
    );
    failCapture();
    await wait(200);
    check(
        doc
            .querySelector(VOICE_TEST_ROOT)
            .textContent.includes("Connect a microphone in System Settings"),
        "Device failure recovery popup is visible",
    );
    check(
        service.uploadContext === undefined,
        "Failure releases upload context",
    );
    doc.querySelector('button[aria-label="Dictate message"]').click();
    await wait(250);
    feed();
    feed();
    feed();
    if (VOICE_TEST_ROOT === "#beaver-pane-window") w.close();
    else
        doc.querySelector(
            `${VOICE_TEST_ROOT} button[aria-label="Close Beaver panel"]`,
        ).click();
    await wait(300);
    check(
        service.controller.getSnapshot().phase === "canceled",
        "Closing the originating surface cancels capture",
    );
    check(disposed, "Closing the originating surface releases capture");
    if (!w.closed) {
        doc.getElementById("zotero-beaver-tb-chat-toggle").click();
        await wait(300);
        check(
            !doc.querySelector(
                'button[aria-label="Stop dictation and transcribe"]',
            ),
            "Reopening does not resume recording",
        );
    }
    return JSON.stringify({
        checks,
        packagedHelper: native.available,
        focus: "mocked for unattended UI test",
    });
} finally {
    editor._compositionKey = originalCompositionKey;
    const state = service.controller.getSnapshot();
    if (state.sessionId) service.controller.cancel(state.sessionId);
    service.start = originalStart;
    service.controller.deps.createCapture = originalCapture;
    native.ensurePackagedHelper = originalEnsure;
    if (focusDescriptor)
        Object.defineProperty(doc, "hasFocus", focusDescriptor);
    else delete doc.hasFocus;
    if (permissionDescriptor)
        Object.defineProperty(native, "permission", permissionDescriptor);
    else delete native.permission;
    if (!w.closed) {
        const currentEditor = doc.querySelector(
            `${VOICE_TEST_ROOT} .beaver-lexical-content`,
        )?.__lexicalEditor;
        if (currentEditor)
            currentEditor.setEditorState(
                currentEditor.parseEditorState(originalState.toJSON()),
            );
    }
    service.uploadContext = undefined;
}
