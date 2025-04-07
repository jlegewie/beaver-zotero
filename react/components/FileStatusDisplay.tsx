import React from 'react';
// @ts-ignore no idea why this is needed
import { useState, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { fileStatusAtom } from '../atoms/ui';
import Button from './button';
import { FileStatus } from '../types/fileStatus';
import { useFileStatus } from '../hooks/useFileStatus';
import { CheckmarkCircleIcon, CancelCircleIcon, UploadCircleIcon, ClockIcon, SyncIcon } from './icons';
import { Icon } from './icons';

interface StatusItemProps {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    count: number;
    className?: string;
    iconClassName?: string;
}

function formatCount(count: number): string {
    if (count >= 1000) {
        return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    }
    return count.toString();
}


const StatusItem: React.FC<StatusItemProps> = ({ icon, count, className = '', iconClassName = '' }) => {
    // Format count to always take at least 2 characters, padding with a non-breaking space
    const formattedCount = formatCount(count);

    return (
        <span className={`flex items-center gap-1 ${className}`}>
            <Icon icon={icon} className={`${iconClassName}`} />
            <span className="text-lg">{formattedCount}</span>
        </span>
    );
};

/**
 * Button component displaying aggregated file processing status.
 */
const FileStatusDisplay: React.FC<{
    className?: string,
    showFileStatus: boolean,
    setShowFileStatus: (showFileStatus: boolean) => void
}> = ({ className = '', showFileStatus = false, setShowFileStatus = () => {} }) => {

    const [fileStatus] = useAtom(fileStatusAtom);
    const [isAnimating, setIsAnimating] = useState(false);
    const prevStatusRef = useRef<FileStatus | null>(null);

    useFileStatus();

    useEffect(() => {
        // Trigger animation only on updates, not initial load
        if (prevStatusRef.current && fileStatus && JSON.stringify(prevStatusRef.current) !== JSON.stringify(fileStatus)) {
            setIsAnimating(true);
            // Adjust timer duration as needed, should match animation duration
            const timer = setTimeout(() => setIsAnimating(false), 400); 
            return () => clearTimeout(timer);
        }
        // Store current status for next comparison
        prevStatusRef.current = fileStatus;
    }, [fileStatus]);

    if (!fileStatus) {
        // Optionally render a loading state or null
        return null; 
    }

    const processingCount = fileStatus.upload_pending + fileStatus.md_queued + fileStatus.md_processing;
    const completedCount = fileStatus.md_converted + fileStatus.md_chunked + fileStatus.md_embedded;
    const failedCount = fileStatus.md_failed + fileStatus.upload_failed;

    // Define animation classes. Ensure 'beaver-flash-border' and 'beaver-flash-bg' 
    // are defined in your CSS (e.g., addon/content/styles/beaver.css) 
    // to create the desired visual effect (e.g., temporary border/background color change).
    const baseClasses = 'transition-colors duration-300 ease-in';
    const flashClasses = 'beaver-flash-border beaver-flash-bg';
    const animationClass = isAnimating ? `${baseClasses} ${flashClasses}` : baseClasses;

    // Conditionally apply 'animate-spin' to SyncIcon
    const syncIconClassName = `scale-125 text-purple-500 ${processingCount > 0 ? 'animate-spin' : ''}`;

    return (
        <Button
            variant="ghost"
            className={`flex fit-content items-center ${animationClass} ${className}`}
            ariaLabel="File processing status"
            title="File Processing Status"
            onClick={() => setShowFileStatus(!showFileStatus)}
        >
            {/* <div className="flex flex-row gap-2"> */}
            <div className="flex flex-row gap-2">
                <StatusItem icon={SyncIcon} count={processingCount} iconClassName={syncIconClassName} />
                <StatusItem icon={CheckmarkCircleIcon} count={completedCount} iconClassName="scale-115 text-green-500" />
                <StatusItem icon={CancelCircleIcon} count={failedCount} iconClassName="scale-115 text-red-500" />
            </div>
        </Button>
    );
};

export default FileStatusDisplay; 