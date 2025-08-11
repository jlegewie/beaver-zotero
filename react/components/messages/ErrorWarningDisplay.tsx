import React from 'react';
import { ChatMessage, WarningMessage } from '../../types/chat/uiTypes';
import { Icon, AlertIcon, KeyIcon, CancelIcon, SettingsIcon } from '../icons/icons';
import { useSetAtom } from 'jotai';
import Button from '../ui/Button';
import { isPreferencePageVisibleAtom } from '../../atoms/ui';
import { removeMessageAtom, removeWarningFromMessageAtom } from '../../atoms/threads';
import IconButton from '../ui/IconButton';
import ZoteroItemsList from '../ui/ZoteroItemsList';

// Get appropriate error message based on the error type
const getErrorMessage = (errorType: string) => {
    switch (errorType) {
        // Error types based on error codes
        case 'service_unavailable':
            return "AI service down. Please try again later.";
        case 'invalid_model':
            return "Invalid model. Please select a different model.";
        case 'rate_limit':
            return "Usage limit reached. Please try again later.";
        case 'content_filtered':
            return "The AI response was blocked by the provider's safety filters.";
        case 'streaming_verification_error':
            return "OpenAI requires verification to use this model with streaming.";
            // https://github.com/jlegewie/beaver-zotero?tab=readme-ov-file#verification-for-openai-api-keys
        case 'beaver_rate_limit':
            return "Beaver rate limit reached. Please try again later.";
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
        case 'inactive_subscription':
            return "Your subscription is inactive. Please upgrade or change to the free version.";
        case 'app_key_limit_exceeded':
            return "You've reached your monthly chat limit. Please upgrade your account or use your own API key.";
        case 'user_key_failed_unexpected':
            return "Unexpected error with your API key.";
        case 'user_key_rate_limit_exceeded':
            return "Your API key hit its usage limit.";
        case 'user_key_failed':
            return "Your API key didn't work. Please check it's correct.";
        case 'user_key_not_set':
            return "Your API key for this model is not set. Please set it in the settings.";
        case 'server_error':
            return "AI service error. Please try again later.";
        default:
            return "Response failed. Please try again.";
    }
};

export const ErrorDisplay: React.FC<{ errorType: string }> = ({ errorType }) => {
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    
    const showSettingsButton = errorType === 'inactive_subscription';
    const showApiKeyButton =
        errorType === 'app_key_limit_exceeded' ||
        errorType === 'user_key_failed_unexpected' ||
        errorType === 'user_key_rate_limit_exceeded' ||
        errorType === 'user_key_failed' ||
        errorType === 'user_key_not_set';

    return (
        <div
            className="display-flex flex-col p-3 gap-3 rounded-lg mb-3"
            style={{ background: 'var(--tag-red-quinary)' }}
        >
            <div className="font-color-red display-flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-11 mt-020" />
                <div className="display-flex flex-col flex-1 gap-2 min-w-0">
                    <div className="display-flex flex-row gap-2 items-start">
                        <div className="text-base">{getErrorMessage(errorType)}</div>
                    </div>
                </div>
            </div>
            {(showSettingsButton || showApiKeyButton || errorType === 'streaming_verification_error') && (
                <div className="font-color-red display-flex flex-row gap-3 items-start">
                    <div className="flex-1"/>
                    {errorType === 'streaming_verification_error' && (
                        <Button
                            variant="outline"
                            className="border-error font-color-red mr-1"
                            onClick={() => {
                                Zotero.launchURL('https://github.com/jlegewie/beaver-zotero?tab=readme-ov-file#verification-for-openai-api-keys');
                            }}
                        >
                            Learn more
                        </Button>
                    )}
                    {(showSettingsButton || showApiKeyButton) && (
                        <Button
                            variant="outline"
                            className="border-error font-color-red mr-1"
                            rightIcon={SettingsIcon}
                            onClick={() => {
                                setIsPreferencePageVisible(true);
                            }}
                        >
                            Settings
                        </Button>
                    )}
                    {/* {showApiKeyButton && (
                        <Button
                            variant="outline"
                            className="scale-90 mt-020 border-error font-color-red"
                            rightIcon={KeyIcon}
                            onClick={() => {
                                setIsPreferencePageVisible(true);
                            }}
                        >
                            API Key
                        </Button>
                    )} */}
                </div>
            )}
        </div>
    );
};


export const WarningDisplay: React.FC<{ messageId: string, warning: WarningMessage, isPlaceholder?: boolean }> = ({ messageId, warning, isPlaceholder }) => {
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const removeWarningFromMessage = useSetAtom(removeWarningFromMessageAtom);
    const removeMessage = useSetAtom(removeMessageAtom);
    const showSettingsIcon = warning.type === 'user_key_failed_unexpected' || warning.type === 'user_key_rate_limit_exceeded' || warning.type === 'user_key_failed';
    
    return (
        <div
            className="display-flex flex-col p-3 gap-3 rounded-lg mb-3 bg-senary"
        >
            <div className="font-color-tertiary display-flex flex-row gap-3 items-start">
                <Icon icon={AlertIcon} className="scale-11 mt-020"/>
                <div className="display-flex flex-col flex-1 gap-2 min-w-0">
                    <div className="display-flex flex-row gap-2 items-start">
                        <div className="text-base">{warning.message}</div>
                        <div className="flex-1"/>
                        {showSettingsIcon &&
                            <Button variant="outline" className="scale-90 mt-020" rightIcon={KeyIcon} onClick={() => {
                                setIsPreferencePageVisible(true);
                            }}>
                                API Key
                            </Button>
                        }
                        <IconButton
                            variant="ghost-secondary"
                            icon={CancelIcon}
                            className="mr-1 scale-90 mt-015"
                            onClick={() => {
                                if (!isPlaceholder) {
                                    removeWarningFromMessage({ id: messageId, warningId: warning.id });                                
                                } else {
                                    removeMessage({ id: messageId });
                                }
                                
                            }}
                        />
                    </div>
                </div>
            </div>
            {warning.attachments && (
                <div className="display-flex flex-col -ml-15">
                    {warning.type === 'missing_attachments' && warning.attachments && (
                        <ZoteroItemsList messageAttachments={warning.attachments} muted={true} oneLine={true}/>
                    )}
                </div>
            )}
        </div>
    );
};


export const MessageErrorWarningDisplay: React.FC<{ message: ChatMessage }> = ({ message }) => {

    if (!!message.warnings && message.status !== 'error') return null;
    
    return (
        <div>
            {message.warnings?.map((warning) => (
                <WarningDisplay key={message.id} messageId={message.id} warning={warning} />
            ))}
            {message.status === 'error' &&
                <ErrorDisplay errorType={message.errorType || 'unknown'} />
            }
        </div>
    );
};
