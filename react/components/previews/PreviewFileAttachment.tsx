import React from 'react';
import { FileResource, RemoteFileResource } from '../../types/resources';

interface PreviewFileAttachmentProps {
    resource: FileResource | RemoteFileResource;
}

const PreviewFileAttachment: React.FC<PreviewFileAttachmentProps> = ({ resource }) => {
    return (
        <h3>{resource.name}</h3>
    );
};

export default PreviewFileAttachment;