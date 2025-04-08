import React from 'react';
// @ts-ignore no idea why this is needed
import { useState, useEffect, useRef } from 'react';
import { useAtomValue, useAtom } from 'jotai';
import { fileStatusStatsAtom, errorCodeStatsAtom, errorCodeLastFetchedAtom } from '../atoms/ui';
import { Icon, InformationCircleIcon, Spinner } from './icons';
import Tooltip from './Tooltip';
import { attachmentsService } from '../../src/services/attachmentsService';

function formatCount(count: number): string {
    if (count >= 10000) {
        return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    } else if (count >= 1000) {
        return count.toLocaleString();
    } else {
        return count.toString();
    }
}

function formatPercentage(percentage: number): string {
    return percentage.toFixed(0).replace(/\.0$/, '') + '%';
}

const Stat: React.FC<{
    label: string,
    count: number,
    isFailed?: boolean,
    info?: boolean,
    isLoading?: boolean,
}> = ({ label, count, isFailed = false, info = false, isLoading = false }) => {
    const formattedCount = formatCount(count);
    const prevCountRef = useRef<number>();
    const [isAnimating, setIsAnimating] = useState(false);
    const timerRef = useRef<NodeJS.Timeout>();

    useEffect(() => {
        // Trigger animation only on updates, not initial load
        if (prevCountRef.current !== undefined && count !== prevCountRef.current) {
            // Clear any existing timer
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
            
            setIsAnimating(true);
            // Store the timer reference
            timerRef.current = setTimeout(() => {
                setIsAnimating(false);
                timerRef.current = undefined;
            }, 500);
        }
        // Update previous count ref *after* checking, for the next render
        prevCountRef.current = count;

        // Cleanup on unmount
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        };
    }, [count]); // Rerun effect only if count changes

    // Base classes including transition
    const baseClasses = "font-color-secondary text-xl transition-colors duration-400 ease-in-out";
    // Animation class based on state and type
    const animationClass = isAnimating
        ? (isFailed ? 'beaver-flash-text-failed' : 'beaver-flash-text-normal')
        : '';

    return (
        <div className="flex flex-col gap-05 items-end">
            <div className="font-color-tertiary text-sm">
                {label}
                {info && <Icon icon={InformationCircleIcon} className="scale-85 mb-1 -mr-2" />}
            </div>
            <div className={`${baseClasses} ${animationClass}`}>
                {isLoading ? <Spinner size={14} /> : formattedCount}
            </div>
        </div>
    );
};

const errorMapping = {
    "encrypted": "File is encrypted",
    "no_text_layer": "Requires OCR",
    "insufficient_text": "Unknown error",
    "file_missing": "Unknown error",
    "download_failed": "Unknown error",
    "preprocessing_failed": "Unknown error",
    "conversion_failed": "Unknown error",
    "opening_failed": "Unknown error",
    "upload_failed": "Unknown error",
    "chunk_failed": "Unknown error",
    "embedding_failed": "Unknown error",
    "db_update_failed": "Unknown error",
    "task_parsing_failed": "Unknown error",
    "max_retries": "Unknown error",
    "unexpected_error": "Unknown error"
};

/**
 * Tooltip content component for displaying processing error codes.
 */
const FailedProcessingTooltipContent: React.FC<{ failedCount: number }> = ({ failedCount }) => {
    const [errorCodeStats, setErrorCodeStats] = useAtom(errorCodeStatsAtom);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorCodeLastFetched, setErrorCodeLastFetched] = useAtom(errorCodeLastFetchedAtom);

    useEffect(() => {
        const shouldFetch = failedCount > 0 &&
                            (errorCodeStats === null || !errorCodeLastFetched || failedCount !== errorCodeLastFetched);

        if (shouldFetch) {
            setIsLoading(true);
            setError(null);
            attachmentsService.getErrorCodeStats('md')
                .then(stats => {
                    setErrorCodeStats(stats);
                    setErrorCodeLastFetched(failedCount);
                })
                .catch(err => {
                    console.error("Failed to fetch error code stats:", err);
                    setError("Could not load details.");
                    // Optionally clear stats if fetch fails
                    // setErrorCodeStats(null);
                })
                .finally(() => {
                    setIsLoading(false);
                });
        } else if (failedCount === 0 && errorCodeStats !== null) {
            // Reset stats if failed count goes to 0
            setErrorCodeStats(null);
            setErrorCodeLastFetched(null);
        }
    }, [failedCount, errorCodeStats, setErrorCodeStats, setErrorCodeLastFetched]); // Re-run effect if count or stats atom changes


    // Aggregate error codes based on errorMapping
    const aggregatedStats: Record<string, number> = {};
    if (errorCodeStats) {
        for (const [code, count] of Object.entries(errorCodeStats)) {
            const message = errorMapping[code as keyof typeof errorMapping] || "Unexpected error";
            aggregatedStats[message] = (aggregatedStats[message] || 0) + count;
        }
    }

    // Display error codes and counts
    return (
        <div className="flex flex-col gap-1">
            <div className="text-base font-color-secondary mb-1 whitespace-nowrap">Processing Errors</div>
            {isLoading &&
                <div className="text-base font-color-secondary mb-1 items-center flex flex-row">
                    <div className="mt-1"><Spinner size={14}/></div>
                    <div className="ml-2 font-color-tertiary">Loading...</div>
                </div>
            }
            {!isLoading && error && <div className="text-base font-color-secondary mb-1">{error}</div>}
            {!isLoading && !error && (
                (!errorCodeStats || Object.keys(aggregatedStats).length === 0) ? (
                    <div className="text-base font-color-secondary">No specific error details available.</div>
                ) : (
                    Object.entries(aggregatedStats).map(([message, count]) => (
                        <div key={message} className="flex justify-between items-center text-base whitespace-nowrap">
                            <span className="font-color-tertiary mr-4">{message}:</span>
                            <span className="font-color-secondary font-mono">{count}</span>
                        </div>
                    ))
                )
            )}
        </div>
    );
};

/**
 * Button component displaying aggregated file processing status.
 */
const FileStatusStats: React.FC<{
    className?: string,
}> = ({ className = '' }) => {

    const fileStats = useAtomValue(fileStatusStatsAtom);

    return (
        <div className="flex flex-col gap-4">

            {/* Overall progress */}
            <div className="flex flex-row items-end">
                <div className="font-color-secondary text-lg">Overall</div>
                <div className="flex-1" />
                <div className="flex flex-row" style={{ width: 'calc(100% - 140px)', maxWidth: '300px' }}>
                    <div className="flex flex-col gap-1 items-end w-full">
                        <div className="font-color-tertiary text-sm">
                            {/* {formatCount(completedFiles) + " / " + formatCount(totalFiles) + " completed"} */}
                            {fileStats.progress < 100 ? formatPercentage(fileStats.progress) + " completed" : formatCount(fileStats.completedFiles) + " completed"}
                        </div>
                        <div className="w-full h-2 bg-tertiary rounded-sm overflow-hidden mb-1" style={{ height: '8px' }}>
                            <div
                                className="h-full bg-primary rounded-sm transition-width duration-500 ease-in-out"
                                style={{ width: `${fileStats.progress}%` }}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Upload stats */}
            <div className="flex flex-row items-end">
                <div className="font-color-secondary text-lg">Uploads</div>
                <div className="flex-1" />
                <div className="flex flex-row gap-5">
                    <Stat label="Pending" count={fileStats.uploadPendingCount} isLoading={!fileStats}/>
                    <Stat label="Done" count={fileStats.uploadCompletedCount} isLoading={!fileStats}/>
                    <Stat label="Failed" count={fileStats.uploadFailedCount} isFailed={true} isLoading={!fileStats} />
                </div>
            </div>

            {/* File processing stats */}
            <div className="flex flex-row items-end">
                <div className="font-color-secondary text-lg">Processing</div>
                <div className="flex-1" />
                <div className="flex flex-row gap-5">
                    <Stat label="Pending" count={fileStats.queuedProcessingCount} isLoading={!fileStats} />
                    {/* <Stat label="Processing" count={fileStats.md_processing + fileStats.md_chunked + fileStats.md_converted}/> */}
                    <Stat label="Active" count={fileStats.activeProcessingCount} isLoading={!fileStats}/>
                    <Stat label="Done" count={fileStats.completedFiles} isLoading={!fileStats}/>
                    {/* Tooltip with detailed error codes */}
                    <Tooltip 
                        content="Processing error codes"
                        customContent={<FailedProcessingTooltipContent failedCount={fileStats.failedProcessingCount} />}
                        showArrow={true}
                        disabled={fileStats.failedProcessingCount === 0}
                        placement="top"
                    >
                        <div>
                             <Stat label="Failed" count={fileStats.failedProcessingCount} isFailed={true} info={true} isLoading={!fileStats}/>
                        </div>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
};

export default FileStatusStats; 