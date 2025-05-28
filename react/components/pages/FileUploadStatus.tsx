import React, { useState } from "react";
import { Icon, RepeatIcon, AlertIcon, ArrowRightIcon, ArrowDownIcon } from "../icons/icons";
import { FileStatusStats } from "../../atoms/ui";
import IconButton from "../ui/IconButton";
import { librarySyncProgressAtom } from "../../atoms/sync";
import { useAtomValue } from "jotai";
import { AttachmentUploadStatistics } from "../../../src/services/database";
import Button from "../ui/Button";
import { ProgressBar, StepTwoIcon, CancelIcon, CheckmarkIcon, SpinnerIcon } from "./OnboardingPage";

const MAX_FAILED_UPLOAD_PERCENTAGE = 0.2;

const FileUploadStatus: React.FC<{
    uploadStats: AttachmentUploadStatistics | null,
    isUploadComplete: boolean,
    uploadError: Error | null,
    progress?: number,
    fileStats?: FileStatusStats,
}> = ({ uploadStats, isUploadComplete, uploadError, progress, fileStats }) => {
    const librarySyncProgress = useAtomValue(librarySyncProgressAtom);
    const [showFailedFiles, setShowFailedFiles] = useState(false);

    const getUploadIcon = (): React.ReactNode => {
        // Ensure library sync is complete
        if (librarySyncProgress.anyFailed) return StepTwoIcon;
        if (librarySyncProgress.progress < 100) return StepTwoIcon;

        // Use upload stats from hook
        if (uploadStats) {
            const failureRate = uploadStats.total > 0 ? uploadStats.failed / uploadStats.total : 0;
            if (failureRate > MAX_FAILED_UPLOAD_PERCENTAGE) return CancelIcon;
            if (isUploadComplete) return CheckmarkIcon;
        }
        
        if (uploadError) return CancelIcon;
        return SpinnerIcon;
    };

    const getUploadLeftText = (): string => {
        if (!uploadStats) return "";
        
        const textParts: string[] = [];
        if (uploadStats.total > 0) textParts.push(`${uploadStats.completed.toLocaleString()} completed`);
        if (uploadStats.failed > 0) textParts.push(`${uploadStats.failed.toLocaleString()} failed`);
        if (uploadStats.skipped > 0) textParts.push(`${uploadStats.skipped.toLocaleString()} skipped`);
        return textParts.join(", ");
    };

    const syncIconClassName = fileStats
        ? `scale-90 ${fileStats.activeProcessingCount > 0 ? 'animate-spin' : ''}`
        : '';
    
    return (
        <div className="display-flex flex-col gap-4 p-3 border-popup rounded-md bg-quinary">
            <div className="display-flex flex-row gap-4">
                <div className="mt-1">
                    {getUploadIcon()}
                </div>
                <div className="display-flex flex-col gap-3 items-start flex-1">

                    {/* Title */}
                    <div className="display-flex flex-row items-center gap-3 w-full min-w-0">
                        <div className="font-color-primary text-lg">Uploading files</div>
                        <div className="flex-1"/>
                        {uploadStats && (
                            <div className="font-color-tertiary text-base">
                                {uploadStats.total.toLocaleString()} Files
                            </div>
                        )}
                    </div>

                    {/* Progress bar and text */}
                    {progress !== undefined && (
                        <div className="w-full">
                            <ProgressBar progress={progress} />
                            <div className="display-flex flex-row gap-4">
                                <div className="font-color-tertiary text-base">
                                    {/* {getUploadLeftText()} */}
                                    {`${uploadStats?.completed.toLocaleString()} completed`}
                                </div>
                                <div className="flex-1"/>
                                <div className="font-color-tertiary text-base">
                                    {`${Math.min(librarySyncProgress.progress, 100).toFixed(0)}%`}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {/* Failed uploads */}
            {uploadStats?.failed && uploadStats.failed > 0 && (
                <div className="display-flex flex-row gap-4">
                    <div className="flex-shrink-0">
                        <Icon icon={AlertIcon} className="scale-12 mt-15 font-color-red" />
                    </div>
                    
                    <div className="display-flex flex-col items-start gap-05 w-full">
                        {/* Icon, Title and button */}
                        <div className="display-flex flex-row items-start gap-3 w-full">
                            
                            {/* <div className={`flex-1 text-base font-medium font-color-red`}>
                                {uploadStats?.failed} failed uploads
                            </div> */}
                            <Button
                                variant="ghost"
                                onClick={() => setShowFailedFiles(!showFailedFiles)}
                                rightIcon={showFailedFiles ? ArrowDownIcon : ArrowRightIcon}
                                iconClassName="mr-0 mt-015 scale-12 font-color-red"
                            >
                                <span className="text-base font-color-red" style={{ marginLeft: '-3px' }}>
                                    {uploadStats?.failed.toLocaleString()} Failed Uploads
                                </span>
                            </Button>
                            <div className="flex-1"/>
                            <div className="flex-shrink-0 display-flex flex-row gap-3">
                                {/* <IconButton
                                    variant="ghost"
                                    icon={InformationCircleIcon}
                                    onClick={() => {}}
                                    iconClassName={`font-color-red`}
                                    className="scale-11"
                                /> */}
                                <IconButton
                                    variant="ghost"
                                    onClick={() => {}}
                                    icon={RepeatIcon}
                                    iconClassName={`font-color-red`}
                                    className="scale-11"
                                />
                                {/* <Button
                                    variant="outline"
                                    onClick={() => {}}
                                >
                                    Retry
                                </Button> */}
                            </div>

                        </div>

                        {/* Details */}
                        {/* <div className={`text-base font-color-red opacity-60`}>Failed files will be excluded from search.</div> */}
                    </div>
                </div>
            )}
        </div>
    );
};


export default FileUploadStatus;