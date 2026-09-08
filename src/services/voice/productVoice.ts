import {
    BatchTranscription,
    type VoiceUploadContext,
} from "./batchTranscription";
import { getPref } from "../../utils/prefs";
import type { NativeVoice } from "./nativeVoice";
import { systemClock, type VoiceAdapters } from "./voiceService";

/** Resources and upload cancellation are owned by the plugin's application-lifetime service. */
export function productVoiceAdapters(
    native: NativeVoice | undefined,
    context: () => VoiceUploadContext | undefined,
): VoiceAdapters {
    return {
        capability: () => ({
            enabled:
                !!getPref("voice.enabled") && !!getPref("voice.nativeEnabled"),
            available: !!native?.available,
        }),
        createCapture: (session, emit) => native!.createCapture(session, emit),
        createTranscription: (session) => {
            // Import web APIs into the plugin realm so uploads survive unrelated window closure.
            Cu.importGlobalProperties([
                "fetch",
                "AbortController",
                "TextEncoder",
                "TextDecoder",
            ]);
            const upload = context();
            if (!upload) throw new Error("Voice upload unavailable");
            return new BatchTranscription(session, upload, {
                fetch: (...args) => fetch(...args),
                yieldTask: () =>
                    new Promise((resolve) =>
                        systemClock().setTimeout(resolve, 0),
                    ),
            });
        },
    };
}
