import React, { useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { ArrowRightIcon, Spinner, LogoutIcon } from '../icons/icons';
import Button from '../ui/Button';
import { profileWithPlanAtom } from '../../atoms/profile';
import { logoutAtom } from '../../atoms/auth';
import { accountService } from '../../../src/services/accountService';
import { logger } from '../../../src/utils/logger';
import { getZoteroUserIdentifier } from '../../../src/utils/zoteroIdentifier';

const DeviceAuthorizationPage: React.FC = () => {
    // Auth state
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const logout = useSetAtom(logoutAtom);
    
    // Loading state
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    
    // Feedback state
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Device id and user id
    const { userID, localUserKey } = getZoteroUserIdentifier();

    // If no user ID, sign out (shouldn't happen)
    // if (!userID) logout();

    // Handle device authorization
    const handleAuthorizeDevice = async () => {
        if (isAuthorizing || !profileWithPlan || !userID || !localUserKey) return;
        
        setIsAuthorizing(true);
        setErrorMsg(null);
        
        try {
            // Get libraries from existing profile
            const libraries = profileWithPlan.libraries || [];
            
            // Call the service to authorize this device
            await accountService.authorizeDevice(userID, localUserKey);

            // Update profile to include this device's local key
            setProfileWithPlan({
                ...profileWithPlan,
                zotero_local_ids: [...(profileWithPlan.zotero_local_ids || []), localUserKey]
            });
            
        } catch (error) {
            logger(`DeviceAuthorizationPage: Error authorizing device: ${error}`);
            setErrorMsg('An unexpected error occurred. Please try again.');
        } finally {
            setIsAuthorizing(false);
        }
    };

    const handleLogout = () => {
        logout();
    };

    return (
        <div 
            id="device-authorization-page"
            className="display-flex flex-col flex-1 min-h-0 min-w-0"
        >
            {/* Scrollable content area */}
            <div className="overflow-y-auto scrollbar flex-1 p-4 mr-1">
                {/* Header section */}
                <div className="display-flex flex-col items-start mb-6">
                    <h1 className="text-2xl font-semibold mb-3">New Device Detected</h1>
                    <p className="text-base font-color-secondary mb-4">
                        You're signing in to Beaver from a new computer. To continue using Beaver on this device, 
                        you need to authorize it to sync with your existing Beaver account.
                    </p>
                     <div className="p-4 rounded-md bg-senary border-popup">
                        <div className="text-base font-semibold mb-2">Important: Keep Zotero Synced</div>
                        <div className="text-sm font-color-secondary">
                            Make sure you're using <strong>Zotero Sync</strong> to keep your libraries synchronized 
                            across all your computers. This ensures Beaver has access to the same items on every device.
                        </div>
                    </div>

                    {/* Error messages */}
                    {errorMsg && (
                        <p className="text-sm font-color-red text-center mt-4">{errorMsg}</p>
                    )}
                </div>
            </div>

            {/* Fixed button area */}
            <div className="p-4 border-top-quinary">
                <div className="display-flex flex-row items-center gap-4">
                    {/* Logout button */}
                    <Button
                        variant="outline"
                        icon={LogoutIcon}
                        onClick={handleLogout}
                        disabled={isAuthorizing}
                    >
                        Sign Out
                    </Button>

                    <div className="flex-1" />

                    {/* Authorize button */}
                    <Button
                        variant="solid"
                        rightIcon={isAuthorizing ? Spinner : ArrowRightIcon}
                        onClick={handleAuthorizeDevice}
                        disabled={isAuthorizing}
                    >
                        {isAuthorizing ? 'Authorizing...' : 'Authorize Device'}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default DeviceAuthorizationPage; 