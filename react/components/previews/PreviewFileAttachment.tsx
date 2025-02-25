import React from 'react';
import { FileAttachment, RemoteFileAttachment } from '../../types/attachments';

interface PreviewFileAttachmentProps {
    attachment: FileAttachment | RemoteFileAttachment;
}

const PreviewFileAttachment: React.FC<PreviewFileAttachmentProps> = ({ attachment }) => {
    return (
        <h3>{attachment.fullName}</h3>
    );
};

export default PreviewFileAttachment;