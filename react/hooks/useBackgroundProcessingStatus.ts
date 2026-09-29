import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    accountGenerationAtom,
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
} from "../atoms/profile";
import { backgroundProcessingStatusAtom } from "../atoms/backgroundProcessing";
import { tryGetWindowRuntime } from "../runtime/windowRuntime";
import { useSurfaceWindow } from "../runtime/SurfaceWindowContext";

const COVERAGE_POLL_MS = 60_000;

/** Whether `doc` is visible (not minimized or fully occluded). */
function useDocumentVisible(doc: Document): boolean {
    const [visible, setVisible] = useState(() => !doc.hidden);
    useEffect(() => {
        // Gecko repeats `visibilitychange` without a state change; the
        // boolean state makes those repeats no-ops.
        const update = () => setVisible(!doc.hidden);
        update();
        doc.addEventListener("visibilitychange", update);
        return () => doc.removeEventListener("visibilitychange", update);
    }, [doc]);
    return visible;
}

/**
 * Keeps `backgroundProcessingStatusAtom` fresh while the calling surface is
 * visible. Local status and remote coverage polling pause while the surface's
 * document is hidden and resume when it becomes visible again.
 */
export function useBackgroundProcessingStatus(
    options: {
        includeCoverage?: boolean;
        includeFailures?: boolean;
        pollIntervalMs?: number;
    } = {},
): () => Promise<void> {
    const accountGeneration = useAtomValue(accountGenerationAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const setStatus = useSetAtom(backgroundProcessingStatusAtom);
    const visible = useDocumentVisible(useSurfaceWindow().document);
    const generation = useRef(0);
    const lastCoverageRequest = useRef<{
        accountGeneration: number;
        at: number;
    } | null>(null);
    const pending = useRef<{
        generation: number;
        again: boolean;
        promise: Promise<void>;
    } | null>(null);

    const refresh = useCallback((): Promise<void> => {
        const epoch = generation.current;
        if (pending.current?.generation === epoch) {
            pending.current.again = true;
            return pending.current.promise;
        }
        const request = {
            generation: epoch,
            again: false,
            promise: Promise.resolve(),
        };
        pending.current = request;
        request.promise = (async () => {
            do {
                request.again = false;
                if (!Zotero.Beaver?.db) return;
                try {
                    const result =
                        await Zotero.Beaver.background!.collectStatus({
                            includeCoverage: false,
                            includeFailures: options.includeFailures,
                        });
                    if (epoch !== generation.current || !result) return;
                    const {
                        progress,
                        queue,
                        ledger,
                        failures,
                        issues,
                        worker,
                        documentCache,
                    } = result;
                    const updatedAt = Date.now();
                    setStatus((previous) => ({
                        ...previous,
                        progress,
                        queue,
                        ledger,
                        worker,
                        documentCache,
                        coverage: hasSearchAccess ? previous.coverage : null,
                        coverageUpdatedAt: hasSearchAccess
                            ? previous.coverageUpdatedAt
                            : null,
                        coverageError: hasSearchAccess
                            ? previous.coverageError
                            : null,
                        failures: failures ?? previous.failures,
                        issues: issues ?? previous.issues,
                        issuesUpdatedAt:
                            issues === undefined
                                ? previous.issuesUpdatedAt
                                : updatedAt,
                        error: null,
                        updatedAt,
                    }));
                } catch (error) {
                    if (epoch !== generation.current) return;
                    setStatus((previous) => ({
                        ...previous,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        updatedAt: Date.now(),
                    }));
                }
            } while (request.again && epoch === generation.current);
        })().finally(() => {
            if (pending.current === request) pending.current = null;
        });
        return request.promise;
    }, [
        accountGeneration,
        hasOcrAccess,
        hasSearchAccess,
        options.includeFailures,
        setStatus,
    ]);

    useEffect(() => {
        // Re-running on visibility refreshes immediately when shown again.
        if (!visible) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const runtime = tryGetWindowRuntime();
        const unsubscribe =
            runtime &&
            Zotero.Beaver?.runtime?.subscribeWindow(
                runtime,
                "background-processing:changed",
                () => {
                    void refresh();
                },
            );
        const poll = async () => {
            await refresh();
            if (!cancelled)
                timer = setTimeout(
                    () => void poll(),
                    options.pollIntervalMs ?? 5_000,
                );
        };
        void poll();
        return () => {
            cancelled = true;
            generation.current++;
            unsubscribe?.();
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [options.pollIntervalMs, refresh, visible]);

    useEffect(() => {
        if (!options.includeCoverage || !hasSearchAccess) {
            lastCoverageRequest.current = null;
            return;
        }
        if (!visible) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            lastCoverageRequest.current = { accountGeneration, at: Date.now() };
            const coverage = await Zotero.Beaver?.background?.collectCoverage();
            if (cancelled) return;
            if (coverage !== undefined)
                setStatus((previous) => ({
                    ...previous,
                    coverage: coverage ?? previous.coverage,
                    coverageUpdatedAt: coverage
                        ? Date.now()
                        : previous.coverageUpdatedAt,
                    coverageError:
                        coverage === null
                            ? "Could not check search coverage."
                            : null,
                }));
            timer = setTimeout(() => void poll(), COVERAGE_POLL_MS);
        };
        // Coverage is a backend request: becoming visible resumes the existing
        // cadence instead of adding a request per visibility change.
        const last = lastCoverageRequest.current;
        const due =
            last?.accountGeneration === accountGeneration
                ? Math.max(0, last.at + COVERAGE_POLL_MS - Date.now())
                : 0;
        if (due === 0) void poll();
        else timer = setTimeout(() => void poll(), due);
        return () => {
            cancelled = true;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [
        accountGeneration,
        options.includeCoverage,
        hasSearchAccess,
        setStatus,
        visible,
    ]);

    return refresh;
}
