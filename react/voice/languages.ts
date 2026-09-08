/** Fixed client choices until language discovery is available. */
export const voiceLanguages = [
    { code: "en", label: "English" },
    { code: "zh", label: "Chinese" },
    { code: "nl", label: "Dutch" },
    { code: "fr", label: "French" },
    { code: "de", label: "German" },
    { code: "it", label: "Italian" },
    { code: "ja", label: "Japanese" },
    { code: "ko", label: "Korean" },
    { code: "pt", label: "Portuguese" },
    { code: "es", label: "Spanish" },
] as const;

/** Recover preferences saved before the fixed language picker existed. */
export function normalizeVoiceLanguage(value: unknown): string {
    const code = typeof value === "string" ? value.trim().toLowerCase() : "";
    return (
        voiceLanguages.find((language) => language.code === code)?.code ?? "en"
    );
}
