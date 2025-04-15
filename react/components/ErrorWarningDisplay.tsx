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
        // Error types based on error codes
        case 'service_unavailable':
            return "AI service down. Please try again later.";
        case 'rate_limit':
            return "Usage limit reached. Please try again later.";
        case 'auth':
            return "Login failed. Please try again later.";
        case 'invalid_request':
            return "Request rejected. Please try again later.";
        case 'network':
            return "Connection lost. Please check your internet.";
        case 'bad_request':
            return "Request format error. Please try again.";
        // Error types yielded by the backend
        case 'temporary_service_error':
            return "AI service hiccup. Please try again later.";
        case 'internal_server_error':
            return "AI service problem. Please try again later.";
        case 'app_key_limit_exceeded':
            return "Monthly chat limit reached. Add your own API key in settings.";
        case 'server_error':
            return "AI service error. Please try again later.";
        default:
            return "Response failed. Please try again.";
    }
};

export const ErrorDisplay: React.FC<{ errorType: string }> = ({ errorType }) => {
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    
    const showSettingsButton = errorType === 'app_key_limit_exceeded';
    
    return (
        <div className="display-flex flex-col gap-0 rounded-md border-quinary mb-3" style={{ borderColor: 'var(--tag-red-tertiary)' }}>
            <div className="font-color-red p-3 display-flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-12 mt-1"/>
                <div className="display-flex flex-col gap-2">
                    <div className="display-flex flex-row gap-4 items-center">
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
      return "Unexpected error with your API key. Switched to app's backup key and default model.";
    case 'user_key_rate_limit_exceeded':
      return "Your API key hit its usage limit. Switched to app's backup key and default model.";
    case 'user_key_failed':
      return "Your API key didn't work. Please check it's correct. Using app's backup key and default model.";
    case 'missing_attachments':
      return "Error processing attachment. Removed from this conversation.";
    default:
      return "Problem with your API key. Using app's backup key and default model.";
  }
};

export const WarningDisplay: React.FC<{ messageId: string, warning: Warning }> = ({ messageId, warning }) => {
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const removeWarningFromMessage = useSetAtom(removeWarningFromMessageAtom);
    const showSettingsIcon = warning.type === 'user_key_failed_unexpected' || warning.type === 'user_key_rate_limit_exceeded' || warning.type === 'user_key_failed';
    
    return (
        <div className="display-flex flex-col gap-0 rounded-md border-quinary mb-4" style={{ borderColor: 'var(--tag-yellow-tertiary)' }}>
            <div className="font-color-yellow p-3 display-flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-12 mt-1"/>
                <div className="display-flex flex-col gap-2">
                    <div className="display-flex flex-row gap-2 items-center">
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