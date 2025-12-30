import React from "react";
import PreferenceToggle from "./PreferenceToggle";

interface EmailToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
}

const EmailToggle: React.FC<EmailToggleProps> = ({ checked, onChange }) => {
    return (
        <PreferenceToggle
            checked={checked}
            onChange={onChange}
            title="Email Notifications"
            subtitle="(optional)"
            description="Receive email notifications with updates and important announcements."
            // tooltip="When enabled, you will receive email notifications for updates and important announcements."
        />
    );
};

export default EmailToggle;