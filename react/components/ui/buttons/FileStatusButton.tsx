import React, { useState, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { fileStatusSummaryAtom } from '../../../atoms/files';
import Button from '../Button';
import { CheckmarkCircleIcon, CancelCircleIcon, UploadCircleIcon, ClockIcon, SyncIcon } from '../../icons/icons';
import { Icon } from '../../icons/icons';

interface StatusItemProps {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    count: number;
    className?: string;
    textClassName?: string;
    iconClassName?: string;
}

function formatCount(count: number): string {
    if (count >= 1000) {
        return (count / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return count.toString();
}


export const StatusItem: React.FC<StatusItemProps> = ({ icon, count, className = '', textClassName = '', iconClassName = '' }) => {
    // Format count to always take at least 2 characters, padding with a non-breaking space
    const formattedCount = formatCount(count);

    return (
        <span className={`display-flex items-center gap-1 ${className}`}>
            <Icon icon={icon} className={`${iconClassName}`} />
            <span className={`${textClassName}`}>{formattedCount}</span>
        </span>
    );
};

/**
 * Button component displaying aggregated file processing status.
 */
const FileStatusButton: React.FC<{
    className?: string,
    showFileStatus: boolean,
    setShowFileStatus: (showFileStatus: boolean) => void
}> = ({ className = '', showFileStatus = false, setShowFileStatus = () => {} }) => {

    const [fileStatusSummary] = useAtom(fileStatusSummaryAtom);
    const [isAnimating, setIsAnimating] = useState(false);
    const prevStatusRef = useRef<any>(null);

    useEffect(() => {
        // Trigger animation only on updates, not initial load
        if (prevStatusRef.current && fileStatusSummary && JSON.stringify(prevStatusRef.current) !== JSON.stringify(fileStatusSummary)) {
            setIsAnimating(true);
            // Adjust timer duration as needed, should match animation duration
            const timer = setTimeout(() => setIsAnimating(false), 400); 
            return () => clearTimeout(timer);
        }
        // Store current status for next comparison
        prevStatusRef.current = fileStatusSummary;
    }, [fileStatusSummary]);

    if (!fileStatusSummary.fileStatusAvailable) {
        // Optionally render a loading state or null
        return null; 
    }

    // Define animation classes
    const baseClasses = 'transition-colors duration-300 ease-in';
    const flashClasses = 'beaver-flash-bg';
    const animationClass = isAnimating ? `${baseClasses} ${flashClasses}` : baseClasses;

    // Conditionally apply 'animate-spin' to SyncIcon
    const syncIconClassName = `scale-125 text-purple-500 ${fileStatusSummary.activeCount > 0 ? 'animate-spin' : ''}`;

    return (
        <Button
            variant="ghost-secondary"
            className={`display-flex fit-content items-center ${animationClass} ${className}`}
            ariaLabel="File processing status"
            title="File Processing Status"
            onClick={() => setShowFileStatus(!showFileStatus)}
        >
            {/* <div className="display-flex flex-row gap-2"> */}
            <div className="display-flex flex-row gap-4">
                <StatusItem icon={ClockIcon} count={fileStatusSummary.queuedProcessingCount} textClassName="text-lg" iconClassName="scale-115" />
                <StatusItem icon={SyncIcon} count={fileStatusSummary.processingProcessingCount} textClassName="text-lg" iconClassName={syncIconClassName} />
                <StatusItem icon={CheckmarkCircleIcon} count={fileStatusSummary.completedFiles} textClassName="text-lg" iconClassName="scale-115 text-green-500" />
                <StatusItem icon={CancelCircleIcon} count={fileStatusSummary.failedCount} textClassName="text-lg" iconClassName="scale-115 text-red-500" />
            </div>
        </Button>
    );
};

export default FileStatusButton; 