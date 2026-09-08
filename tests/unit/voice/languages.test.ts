import { expect, it } from "vitest";
import {
    voiceLanguages,
    normalizeVoiceLanguage,
} from "../../../react/voice/languages";
import { DevelopmentVoiceHarness } from "../../../src/services/voice/developmentHarness";

it.each(voiceLanguages)("controller accepts $label", ({ code }) => {
    const harness = new DevelopmentVoiceHarness({
        setTimeout: () => 0,
        clearTimeout: () => {},
    });
    harness.run({ command: "enable", enabled: true });
    const win = {
        closed: false,
        document: { hasFocus: () => true },
        addEventListener() {},
        removeEventListener() {},
    };
    expect(
        harness.service.start(
            win,
            { kind: "composer", id: "language-test" },
            () => new Promise(() => {}),
            "user",
            { language: code, biasTerms: [], correctionVocabulary: [] },
        ),
    ).toHaveProperty("sessionId");
    harness.service.dispose();
});
it.each([
    ["EN", "en"],
    [" DE ", "de"],
    ["en-x", "en"],
    ["abcd", "en"],
    [undefined, "en"],
    ["fr", "fr"],
])("normalizes %s", (value, expected) => {
    expect(normalizeVoiceLanguage(value)).toBe(expected);
});
