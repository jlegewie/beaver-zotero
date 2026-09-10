import { isVoiceWindowBlur } from "../../src/services/voice/voiceService";
import { voiceDraftSourcesAtom, voiceClaimedResultAtom } from "../voice/draft";
import { useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import {
    idleVoiceSnapshot,
    isBusyPhase,
    type VoiceSnapshot,
} from "@beaver/agent-core/voice/contracts";
import { getApiBaseUrl } from "@beaver/agent-core/transport/config";
import { credentials } from '@beaver/agent-core/transport/credentials';
import type { LexicalEditorInputHandle } from "@beaver/agent-ui/composer/LexicalEditorInput";
import { getPref } from "../../src/utils/prefs";
import { sessionAtom } from "../atoms/auth";
import {
    profileWithPlanAtom,
    searchableLibraryIdsAtom,
} from "../atoms/profile";
import { composerResetTokenAtom } from "../atoms/messageComposition";
import { zoteroContextAtom } from "../atoms/zoteroContext";
import {
    collectVoiceVocabulary,
    type VoiceSourceSnapshot,
} from "../voice/vocabulary";
import { hasVoiceCredits } from "../voice/credits";
import { normalizeVoiceLanguage } from "../voice/languages";
import { addPopupMessageAtom } from "../utils/popupMessageUtils";

export const voiceMessages: Record<string, string> = {
    permission_denied:
        "Allow Beaver Voice Input in System Settings → Privacy & Security → Microphone, then try again.",
    no_speech:
        "No speech detected. Check that your microphone is unmuted and try again.",
    insufficient_credits:
        "Dictation requires Beaver credits, including when using your own model key.",
    source_ineligible:
        "Source access changed. Start a new dictation with eligible sources.",
    unauthenticated: "Sign in again before starting a new dictation.",
    outcome_unknown:
        "The dictation outcome is uncertain and may have used credits. Audio was not retried.",
    busy: "Another voice session is active.",
    disabled: "Voice dictation is not enabled on the backend.",
    unavailable:
        "Voice input is unavailable. Check the helper and backend configuration.",
    device_unavailable:
        "Connect a microphone in System Settings → Sound → Input, then try again.",
    duration_limit:
        "Dictation is limited to two minutes. Try a shorter recording.",
    transcription_timeout:
        "Transcription timed out. Audio was not retried; credits may have been used.",
};

/** A mounted composer owns one immutable output identity; all views observe the global lock. */
export function useComposerVoice(
    input: React.RefObject<HTMLElement | null>,
    editor: React.RefObject<LexicalEditorInputHandle | null>,
) {
    const store = useStore();
    const service = Zotero.Beaver?.voice;
    const [id] = useState(() => service?.createOutputId() ?? "unavailable");
    const native = Zotero.Beaver?.voiceNative;
    const [snapshot, setSnapshot] = useState<VoiceSnapshot>(
        () => service?.controller.getSnapshot() ?? idleVoiceSnapshot(),
    );
    const [preparing, setPreparing] = useState(false);
    const [globalPreparing, setGlobalPreparing] = useState(
        service?.preparing ?? false,
    );
    useEffect(
        () =>
            service?.subscribePreparation(() =>
                setGlobalPreparing(service.preparing),
            ),
        [service],
    );
    const notify = (text: string, type: "error" | "warning" = "error") => {
        store.set(addPopupMessageAtom, {
            id: `voice-${id}-${type}`,
            type,
            title: type === "error" ? "Voice dictation" : "Microphone level",
            text,
            duration: 8000,
        });
    };
    const warned = useRef(new Set<string>());
    const [levels, setLevels] = useState<number[]>([]);
    const lastFrame = useRef({ sessionId: "", count: 0 });
    const profile = useAtomValue(profileWithPlanAtom);
    const reset = useAtomValue(composerResetTokenAtom);
    const attempt = useRef(0);
    const claimedResult = useAtomValue(voiceClaimedResultAtom);
    const sources = useRef<VoiceSourceSnapshot | null>(null);
    const activeReset = useRef(reset);
    const preparingRef = useRef(false);
    const permissionSetup = useRef(false);
    const setupAbort = useRef<AbortController | null>(null);
    const releasePreparation = useRef<(() => void) | null>(null);
    const eligible = (library: number) =>
        store.get(searchableLibraryIdsAtom).includes(library);
    const visible = () =>
        !!input.current?.isConnected && !!input.current.getClientRects().length;
    const owns = snapshot.owner?.output.id === id;
    const pendingResult = (
        state: VoiceSnapshot | undefined,
        claimed = store.get(voiceClaimedResultAtom),
    ) =>
        state?.phase === "completed" &&
        !!state.committedText &&
        state.owner?.output.kind === "composer" &&
        state.sessionId !== claimed;
    const busy =
        preparing ||
        globalPreparing ||
        isBusyPhase(snapshot.phase) ||
        pendingResult(snapshot, claimedResult);
    const cancel = () => {
        setupAbort.current?.abort();
        releasePreparation.current?.();
        releasePreparation.current = null;
        attempt.current++;
        preparingRef.current = false;
        setPreparing(false);
        const state = service?.controller.getSnapshot();
        if (state?.owner?.output.id === id && state.sessionId) {
            store.set(voiceClaimedResultAtom, state.sessionId);
            service?.controller.cancel(state.sessionId);
        }
    };
    const insertResult = () => {
        const state = service?.controller.getSnapshot();
        if (
            !visible() ||
            activeReset.current !== store.get(composerResetTokenAtom)
        ) {
            cancel();
            return;
        }
        if (state?.owner?.output.id !== id) return;
        if (
            state.phase === "completed" &&
            state.committedText &&
            pendingResult(state) &&
            activeReset.current === store.get(composerResetTokenAtom)
        ) {
            if (
                sources.current?.libraryIds.some(
                    (library) => !eligible(library),
                )
            ) {
                store.set(voiceClaimedResultAtom, state.sessionId);
                notify(voiceMessages.source_ineligible);
                return;
            }
            if (editor.current?.appendText(state.committedText)) {
                const previous = store.get(voiceDraftSourcesAtom);
                const resetToken = store.get(composerResetTokenAtom);
                store.set(voiceDraftSourcesAtom, {
                    resetToken,
                    libraryIds: [
                        ...new Set([
                            ...(previous?.resetToken === resetToken
                                ? previous.libraryIds
                                : []),
                            ...(sources.current?.libraryIds ?? []),
                        ]),
                    ],
                });
                store.set(voiceClaimedResultAtom, state.sessionId);
            }
        }
    };
    useEffect(
        () =>
            service?.controller.subscribe(() => {
                const state = service.controller.getSnapshot();
                setSnapshot(state);
                if (state.phase === "completed") insertResult();
                if (
                    state.owner?.output.id === id &&
                    state.phase === "listening" &&
                    state.frameCount > 0 &&
                    (lastFrame.current.sessionId !== state.sessionId ||
                        lastFrame.current.count !== state.frameCount)
                ) {
                    lastFrame.current = {
                        sessionId: state.sessionId!,
                        count: state.frameCount,
                    };
                    setLevels((previous) =>
                        [...previous, state.level].slice(-80),
                    );
                }
            }),
        [service, id],
    );
    useEffect(() => {
        cancel();
        sources.current = null;
    }, [reset]);
    useEffect(() => {
        const win = input.current?.ownerDocument.defaultView;
        if (!win) return;
        const key = (event: KeyboardEvent) => {
            const state = service?.controller.getSnapshot();
            if (
                event.key === "Escape" &&
                (preparingRef.current ||
                    (state?.owner?.output.id === id &&
                        (isBusyPhase(state.phase) || pendingResult(state))))
            ) {
                event.preventDefault();
                event.stopImmediatePropagation();
                cancel();
            }
        };
        const blur = (event: Event) => {
            if (isVoiceWindowBlur(event, win) && !permissionSetup.current)
                cancel();
        };
        win.addEventListener("blur", blur);
        win.addEventListener("keydown", key, true);
        // Also catch a composer hidden without unmounting and pending insertion during IME.
        const timer = win.setInterval(() => {
            if (!visible()) {
                cancel();
                return;
            }
            insertResult();
        }, 100);
        return () => {
            win.removeEventListener("blur", blur);
            win.removeEventListener("keydown", key, true);
            win.clearInterval(timer);
            cancel();
        };
    }, [service, id, input, editor, store]);
    useEffect(() => {
        if (owns && snapshot.phase === "error")
            notify(
                voiceMessages[snapshot.error?.code ?? ""] ??
                    "Dictation stopped. Check your microphone or connection and try again. Audio was not retried.",
            );
    }, [snapshot.phase, snapshot.error, owns]);

    useEffect(() => {
        if (!owns || snapshot.phase !== "listening") return;
        const warning = snapshot.clipping
            ? "clipping"
            : snapshot.sampleCount >= 16000 &&
                levels.length > 0 &&
                levels.every((level) => level < 0.01)
              ? "lowSignal"
              : null;
        if (!warning || warned.current.has(warning)) return;
        warned.current.add(warning);
        notify(
            warning === "clipping"
                ? "Microphone clipping — speak more softly or lower input volume."
                : "Low microphone signal — move closer or check your input level.",
            "warning",
        );
    }, [owns, snapshot.phase, snapshot.clipping, snapshot.sampleCount, levels]);

    const toggle = async () => {
        const current = service?.controller.getSnapshot();
        if (
            current?.owner?.output.id === id &&
            current.phase === "listening" &&
            current.sessionId
        ) {
            void service?.controller.finish(current.sessionId);
            return;
        }
        if (
            busy ||
            pendingResult(current) ||
            preparingRef.current ||
            !service ||
            !native
        )
            return;
        const win = input.current?.ownerDocument.defaultView;
        const user = store.get(sessionAtom)?.user.id;
        if (!win || !visible() || !win.document.hasFocus() || !user) return;
        if (!hasVoiceCredits(store.get(profileWithPlanAtom))) {
            notify(voiceMessages.insufficient_credits);
            return;
        }
        const release = service.claimPreparation();
        if (!release) return;
        releasePreparation.current = release;
        const abort = new AbortController();
        setupAbort.current = abort;
        const generation = ++attempt.current;
        const resetToken = store.get(composerResetTokenAtom);
        const context = store.get(zoteroContextAtom);
        const language = normalizeVoiceLanguage(getPref("voice.language"));
        const valid = () =>
            attempt.current === generation &&
            visible() &&
            !win.closed &&
            resetToken === store.get(composerResetTokenAtom) &&
            store.get(sessionAtom)?.user.id === user;
        preparingRef.current = true;
        setPreparing(true);
        warned.current.clear();
        setLevels([]);
        try {
            await native.ensurePackagedHelper();
            if (!valid()) return;
            if (native.permission !== "granted") {
                permissionSetup.current = true;
                const permission = await native.prepareMicrophone(
                    win,
                    abort.signal,
                );
                if (attempt.current === generation)
                    permissionSetup.current = false;
                if (valid()) {
                    if (permission === "granted") {
                        store.set(addPopupMessageAtom, {
                            type: "info",
                            title: "Microphone ready",
                            text: "Click the microphone again to record.",
                        });
                    } else {
                        notify(voiceMessages.permission_denied);
                    }
                }
                return;
            }
            const snapshot = await collectVoiceVocabulary(
                context,
                language,
                eligible,
            );
            if (!valid() || !win.document.hasFocus()) return;
            sources.current = snapshot;
            activeReset.current = resetToken;
            const validate = () =>
                valid() &&
                process.env.NODE_ENV !== "production" &&
                getPref("voice.enabled") &&
                getPref("voice.nativeEnabled") &&
                snapshot.libraryIds.every(eligible) &&
                hasVoiceCredits(store.get(profileWithPlanAtom));
            release();
            const result = service.start(
                win,
                { kind: "composer", id },
                async () => {
                    if (!validate()) return null;
                    const { data, error } = await credentials.getSession();
                    if (error || !validate() || data.session?.user.id !== user)
                        return null;
                    return {
                        userId: user,
                        credential: data.session.access_token,
                    };
                },
                user,
                snapshot.options,
                { baseUrl: getApiBaseUrl(), validate },
            );
            if ("error" in result)
                notify(
                    voiceMessages[result.error.code] ??
                        "Dictation could not start. Check your settings and try again.",
                );
        } catch {
            if (valid())
                notify(
                    "Voice setup failed. Check microphone permissions and the packaged helper, then try again.",
                );
        } finally {
            release();
            if (attempt.current === generation) {
                permissionSetup.current = false;
                preparingRef.current = false;
                setPreparing(false);
            }
        }
    };
    return {
        enabled:
            process.env.NODE_ENV !== "production" &&
            !!Zotero.isMac &&
            !!getPref("voice.enabled") &&
            !!getPref("voice.nativeEnabled"),
        busy,
        listening: owns && snapshot.phase === "listening",
        processing:
            preparing ||
            (owns && pendingResult(snapshot, claimedResult)) ||
            (owns && ["starting", "finalizing"].includes(snapshot.phase)),
        canStart: hasVoiceCredits(profile),
        toggle,
        cancel,
        levels,
        clipping: owns && snapshot.clipping,
        lowSignal:
            owns &&
            snapshot.sampleCount >= 16000 &&
            levels.length > 0 &&
            levels.every((level) => level < 0.01),
        seconds: Math.floor(snapshot.sampleCount / 16000),
        canSend: () => {
            if (
                preparingRef.current ||
                service?.preparing ||
                pendingResult(service?.controller.getSnapshot()) ||
                isBusyPhase(service?.controller.getSnapshot().phase ?? "idle")
            )
                return false;
            const draft = store.get(voiceDraftSourcesAtom);
            if (
                draft?.resetToken === store.get(composerResetTokenAtom) &&
                !draft.libraryIds.every(eligible)
            ) {
                notify(voiceMessages.source_ineligible);
                return false;
            }
            return true;
        },
    };
}
