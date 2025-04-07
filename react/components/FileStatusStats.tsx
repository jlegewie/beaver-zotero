import React from 'react';
// @ts-ignore no idea why this is needed
import { useState, useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { fileStatusAtom } from '../atoms/ui';
import { Icon } from './icons';

function formatCount(count: number): string {
    if (count >= 10000) {
        return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    } else if (count >= 1000) {
        return count.toLocaleString();
    } else {
        return count.toString();
    }
}

const Stat: React.FC<{ label: string, count: number, isFailed?: boolean }> = ({ label, count, isFailed = false }) => {
    const formattedCount = formatCount(count);
    const prevCountRef = useRef<number>();
    const [isAnimating, setIsAnimating] = useState(false);

    useEffect(() => {
        // Trigger animation only on updates, not initial load
        if (prevCountRef.current !== undefined && count !== prevCountRef.current) {
            setIsAnimating(true);
            // Duration should ideally match CSS transition duration + a little extra
            const timer = setTimeout(() => setIsAnimating(false), 500); 
            // Cleanup timer on component unmount or before next effect run
            return () => clearTimeout(timer);
        }
        // Update previous count ref *after* checking, for the next render
        prevCountRef.current = count;
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
            </div>
            <div className={`${baseClasses} ${animationClass}`}>
                {formattedCount}
            </div>
        </div>
    );
};

/**
 * Button component displaying aggregated file processing status.
 */
const FileStatusStats: React.FC<{
    className?: string,
}> = ({ className = '' }) => {

    const fileStatus = useAtomValue(fileStatusAtom);

    // const processingCount = fileStatus.upload_pending + fileStatus.md_queued + fileStatus.md_processing;
    // const completedCount = fileStatus.md_converted + fileStatus.md_chunked + fileStatus.md_embedded;
    // const failedCount = fileStatus.md_failed + fileStatus.upload_failed;

    // Define animation classes. Ensure 'beaver-flash-border' and 'beaver-flash-bg' 
    // are defined in your CSS (e.g., addon/content/styles/beaver.css) 
    // to create the desired visual effect (e.g., temporary border/background color change).
    // const baseClasses = 'transition-colors duration-300 ease-in';
    // const flashClasses = 'beaver-flash-border beaver-flash-bg';
    // const animationClass = isAnimating ? `${baseClasses} ${flashClasses}` : baseClasses;

    // Conditionally apply 'animate-spin' to SyncIcon
    // const syncIconClassName = `scale-125 text-purple-500 ${processingCount > 0 ? 'animate-spin' : ''}`;

    // Maybe render a loading state?
    if (!fileStatus) {
        return null; 
    }

    return (
        <>
            <div className="flex flex-row items-end">
                <div className="font-color-secondary text-lg">Uploads</div>
                <div className="flex-1" />
                <div className="flex flex-row gap-5">
                    <Stat label="Pending" count={fileStatus.upload_pending}/>
                    <Stat label="Done" count={fileStatus.upload_completed}/>
                    <Stat label="Failed" count={fileStatus.upload_failed} isFailed={true} />
                </div>
            </div>
            <div className="flex flex-row items-end">
                <div className="font-color-secondary text-lg">Processing</div>
                <div className="flex-1" />
                <div className="flex flex-row gap-5">
                    <Stat label="Pending" count={fileStatus.md_queued}/>
                    {/* <Stat label="Processing" count={fileStatus.md_processing + fileStatus.md_chunked + fileStatus.md_converted}/> */}
                    <Stat label="Active" count={fileStatus.md_processing + fileStatus.md_chunked + fileStatus.md_converted}/>
                    <Stat label="Done" count={fileStatus.md_embedded}/>
                    <Stat label="Failed" count={fileStatus.md_failed} isFailed={true} />
                </div>
            </div>
        </>
    );
};

export default FileStatusStats; 