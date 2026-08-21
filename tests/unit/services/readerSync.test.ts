import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshMovedAnnotationsInOpenReaders } from "../../../src/services/annotations/readerSync";

describe("refreshMovedAnnotationsInOpenReaders", () => {
    const unsetAnnotations = vi.fn();
    const setAnnotations = vi.fn(async () => {});
    const renderPrimary = vi.fn();
    const renderSecondary = vi.fn();

    beforeEach(() => {
        unsetAnnotations.mockClear();
        setAnnotations.mockClear();
        renderPrimary.mockClear();
        renderSecondary.mockClear();
        (globalThis as any).Zotero.Reader = {
            _readers: [
                {
                    itemID: 100,
                    unsetAnnotations,
                    setAnnotations,
                    _internalReader: {
                        _primaryView: { _render: renderPrimary },
                        _secondaryView: { _render: renderSecondary },
                    },
                },
                {
                    itemID: 200,
                    unsetAnnotations: vi.fn(),
                    setAnnotations: vi.fn(),
                },
            ],
        };
    });

    it("removes stale reader objects before adding moved annotations", async () => {
        const item = { key: "ANN00001" } as Zotero.Item;

        await refreshMovedAnnotationsInOpenReaders([
            { attachmentID: 100, item },
        ]);

        expect(unsetAnnotations).toHaveBeenCalledWith(["ANN00001"]);
        expect(setAnnotations).toHaveBeenCalledWith([item]);
        expect(unsetAnnotations.mock.invocationCallOrder[0]).toBeLessThan(
            setAnnotations.mock.invocationCallOrder[0],
        );
        expect(renderPrimary).toHaveBeenCalledOnce();
        expect(renderSecondary).toHaveBeenCalledOnce();
        expect(setAnnotations.mock.invocationCallOrder[0]).toBeLessThan(
            renderPrimary.mock.invocationCallOrder[0],
        );
    });

    it("continues refreshing later readers when one reader fails", async () => {
        const item = { key: "ANN00001" } as Zotero.Item;
        const failingUnset = vi.fn();
        const failingSet = vi.fn(async () => {
            // Closing a reader removes it from Zotero's live registry. The
            // helper must still visit the reader that followed it.
            (globalThis as any).Zotero.Reader._readers.splice(0, 1);
            throw new Error("reader closed");
        });
        const healthyUnset = vi.fn();
        const healthySet = vi.fn(async () => {});
        const healthyRender = vi.fn();
        (globalThis as any).Zotero.Reader._readers = [
            {
                itemID: 100,
                unsetAnnotations: failingUnset,
                setAnnotations: failingSet,
            },
            {
                itemID: 100,
                unsetAnnotations: healthyUnset,
                setAnnotations: healthySet,
                _internalReader: {
                    _primaryView: { _render: healthyRender },
                },
            },
        ];

        await refreshMovedAnnotationsInOpenReaders([
            { attachmentID: 100, item },
        ]);

        expect(failingUnset).toHaveBeenCalledWith(["ANN00001"]);
        expect(failingSet).toHaveBeenCalledWith([item]);
        expect(healthyUnset).toHaveBeenCalledWith(["ANN00001"]);
        expect(healthySet).toHaveBeenCalledWith([item]);
        expect(healthyRender).toHaveBeenCalledOnce();
    });
});
