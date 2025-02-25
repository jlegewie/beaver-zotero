import React from 'react';
import { FileResource, RemoteFileResource } from '../../types/resources';

interface PreviewFileResourceProps {
    resource: FileResource | RemoteFileResource;
}

const PreviewFileResource: React.FC<PreviewFileResourceProps> = ({ resource }) => {
    return (
        <h3>{resource.name}</h3>
    );
};

export default PreviewFileResource;