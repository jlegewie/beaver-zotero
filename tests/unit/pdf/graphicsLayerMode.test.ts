/**
 * Unit tests for the `graphicsLayerMode` extraction setting + its
 * `shouldProbeGraphicsLayer` helper.
 *
 * The setting gates whether the per-page WASM→JS device walk runs at
 * the worker call sites (`worker/sentenceExtraction.ts`,
 * `worker/ops.ts`). The walk is the dominant per-page perf cost of
 * the fill-rect feature (one bridge crossing per drawing primitive,
 * dominated by `fill_text` events on text-dense pages), so a clean
 * way to opt out matters for performance-sensitive callers whose
 * corpus doesn't use tinted display containers.
 */
import { describe, it, expect } from "vitest";
import {
    DEFAULT_EXTRACTION_SETTINGS,
    shouldProbeGraphicsLayer,
} from "../../../src/services/pdf/types";

describe("shouldProbeGraphicsLayer", () => {
    it("returns false for 'off' — opts out of the device walk", () => {
        expect(shouldProbeGraphicsLayer("off")).toBe(false);
    });

    it("returns true for 'on' — explicit opt-in", () => {
        expect(shouldProbeGraphicsLayer("on")).toBe(true);
    });

    it("returns true for 'auto' — preserves v0.20 feature behavior until smart-gate ships", () => {
        // `"auto"` is the default. Today it must behave like `"on"`
        // so the fill-rect feature still helps the documents that
        // need it (DDS69CQI). A future smart-gate will differentiate
        // the two — this test pins the current "always probe"
        // semantics so the change is intentional, not accidental.
        expect(shouldProbeGraphicsLayer("auto")).toBe(true);
    });

    it("returns true for undefined — legacy callers default to probing", () => {
        // Worker-internal helpers may receive an undefined mode when
        // the caller predates the field. They get the same behavior
        // as the documented default `"auto"`.
        expect(shouldProbeGraphicsLayer(undefined)).toBe(true);
    });
});

describe("ExtractionSettings.graphicsLayerMode default", () => {
    it("default is 'auto'", () => {
        // Pins the default value users see when they pass no
        // settings. Changing this is a public-behavior change — the
        // test exists so any future refactor that flips the default
        // is intentional rather than incidental.
        expect(DEFAULT_EXTRACTION_SETTINGS.graphicsLayerMode).toBe("auto");
    });
});
