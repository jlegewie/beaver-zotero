import React, { useState, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { fileStatusSummaryAtom } from '../../../atoms/files';
import Button from '../Button';
import FileStatusIcons from '../FileStatusIcons';


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
            <FileStatusIcons />
        </Button>
    );
};

export default FileStatusButton; 