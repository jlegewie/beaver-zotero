import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    accountGenerationAtom,
    hasOcrAccessAtom,
    hasSearchIndexAccessAtom,
} from "../atoms/profile";
import { backgroundProcessingStatusAtom } from "../atoms/backgroundProcessing";
import { tryGetWindowRuntime } from "../runtime/windowRuntime";

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
    const generation = useRef(0);
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
    }, [options.pollIntervalMs, refresh]);

    useEffect(() => {
        if (!options.includeCoverage || !hasSearchAccess) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
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
            timer = setTimeout(() => void poll(), 60_000);
        };
        void poll();
        return () => {
            cancelled = true;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [
        accountGeneration,
        options.includeCoverage,
        hasSearchAccess,
        setStatus,
    ]);

    return refresh;
}
