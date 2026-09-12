import { isSessionExpiredError } from "@beaver/agent-core/types/apiErrors";
import { isTransientNetworkError } from "./isTransientNetworkError";

export type ChatLoadError = {
    kind: "offline" | "transient" | "session" | "generic";
};

export function classifyChatLoadError(error: unknown): ChatLoadError {
    if (isSessionExpiredError(error)) return { kind: "session" };
    if (isTransientNetworkError(error)) {
        const offline =
            (typeof Services !== "undefined" &&
                Services.io?.offline === true) ||
            (typeof navigator !== "undefined" && navigator.onLine === false);
        return { kind: offline ? "offline" : "transient" };
    }
    return { kind: "generic" };
}
