import React from 'react';
import { Warning } from '../types/messages';
import { Icon, AlertIcon, SettingsIcon, KeyIcon, CancelIcon } from './icons';
import { useSetAtom } from 'jotai';
import Button from './button';
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { removeWarningFromMessageAtom } from '../atoms/threads';
import IconButton from './IconButton';

// Get appropriate error message based on the error type
const getErrorMessage = (errorType: string) => {
    
    switch (errorType) {
        // Error types based on error codes\
        case 'service_unavailable':
            return "The AI service is currently unavailable. Please try again later.";
        case 'rate_limit':
            return "Rate limit exceeded. Please try again later.";
        case 'auth':
            return "Authentication error. Please check your API key.";
        case 'invalid_request':
            return "Invalid API request. The API key may be incorrect.";
        case 'network':
            return "Network connection error. Please check your internet connection.";
        case 'bad_request':
            return "The request to the AI service was invalid.";
        // Error types yielded by the backend
        case 'temporary_service_error':
            return "The AI service encountered an error. Please try again later.";
        case 'internal_server_error':
            return "The AI service encountered an error. Please try again later.";
        case 'app_key_limit_exceeded':
            return "You have exceeded your monthly chat limit. Consider adding your own API key in settings.";
        case 'server_error':
            return "The AI service encountered an error. Please try again later.";
        default:
            return "Error completing the response. Please try again.";
    }
};

export const ErrorDisplay: React.FC<{ errorType: string }> = ({ errorType }) => {
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    
    const showSettingsButton = errorType === 'app_key_limit_exceeded';
    
    return (
        <div className="flex flex-col gap-0 rounded-md border-quinary mb-3" style={{ borderColor: 'var(--tag-red-tertiary)' }}>
            <div className="font-color-red p-3 flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-12 mt-1"/>
                <div className="flex flex-col gap-2">
                    <div className="flex flex-row gap-4 items-center">
                        <div>Error</div>
                        <div className="flex-1"/>
                        {showSettingsButton &&
                            <Button variant="outline" className="scale-90" rightIcon={KeyIcon} onClick={() => {
                                setIsPreferencePageVisible(true);
                            }}>
                                API Key
                            </Button>
                        }
                    </div>
                    <div className="text-sm">{getErrorMessage(errorType)}</div>
                </div>
            </div>
        </div>
    );
};

const getWarning = (type: string) => {
    switch (type) {
        case 'user_key_failed_unexpected':
            return "Your API key failed because of an unexpected error. Please check your API key in settings. Using our application key as a fallback.";
        case 'user_key_rate_limit_exceeded':
            return "Your API key failed because of a rate limit. Please check your API key in settings. Using our application key as a fallback.";
        case 'user_key_failed':
            return "Unable to authenticate with your API key. Please confirm it is correct. Using our application key as a fallback.";
        case 'missing_attachments':
            return "Unable to process attachment XXX. Please check the attachment and try again.";
        default:
            return "Unexpected error using your API key. Using our application key as a fallback.";
    }
};

export const WarningDisplay: React.FC<{ messageId: string, warning: Warning }> = ({ messageId, warning }) => {
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const removeWarningFromMessage = useSetAtom(removeWarningFromMessageAtom);
    const showSettingsIcon = warning.type === 'user_key_failed_unexpected' || warning.type === 'user_key_rate_limit_exceeded' || warning.type === 'user_key_failed';
    
    return (
        <div className="flex flex-col gap-0 rounded-md border-quinary mb-4" style={{ borderColor: 'var(--tag-yellow-tertiary)' }}>
            <div className="font-color-yellow p-3 flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-12 mt-1"/>
                <div className="flex flex-col gap-2">
                    <div className="flex flex-row gap-2 items-center">
                        <div>Warning</div>
                        <div className="flex-1"/>
                        {showSettingsIcon &&
                            <Button variant="outline" className="scale-90" rightIcon={KeyIcon} onClick={() => {
                                setIsPreferencePageVisible(true);
                            }}>
                                API Key
                            </Button>
                        }
                        <IconButton
                            variant="outline"
                            icon={CancelIcon}
                            className="mr-1 scale-90"
                            onClick={() => {
                                removeWarningFromMessage({ id: messageId, warningId: warning.id });                                
                            }}
                        />
                    </div>
                    <div className="text-sm">{getWarning(warning.type)}</div>
                </div>
            </div>
            
        </div>
    );
};