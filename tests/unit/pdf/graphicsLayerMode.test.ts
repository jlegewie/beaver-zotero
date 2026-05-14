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

    it("returns true for 'auto' — explicit smart-gate opt-in", () => {
        expect(shouldProbeGraphicsLayer("auto")).toBe(true);
    });

    it("returns false for undefined — omitted settings use the off default", () => {
        expect(shouldProbeGraphicsLayer(undefined)).toBe(false);
    });
});

describe("ExtractionSettings.graphicsLayerMode default", () => {
    it("default is 'off'", () => {
        expect(DEFAULT_EXTRACTION_SETTINGS.graphicsLayerMode).toBe("off");
    });
});
