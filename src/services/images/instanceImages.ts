/**
 * Image decoding and re-encoding (`addon.images`), owned by the plugin realm.
 *
 * Renderers reach it through `processImageBytes`, so the work never depends
 * on the window that asked for it. Images are processed one at a time, in
 * arrival order: a decoded bitmap can take 256 MB (`MAX_DECODED_PIXELS` at
 * four bytes per pixel), and several windows' agent requests could otherwise
 * hold such bitmaps at once.
 */

import {
    ImageProcessingError,
    imageImplementations,
    type ProcessImageOptions,
    type ProcessedImage,
} from './imageProcessing';

export class InstanceImages {
    private closed = false;
    /** Settles when the last admitted or waiting request finishes. */
    private tail: Promise<void> = Promise.resolve();

    /** Decode, downscale, and re-encode an image once earlier requests finish. */
    async process(
        bytes: Uint8Array,
        mimeType: string,
        options: ProcessImageOptions,
    ): Promise<ProcessedImage> {
        if (this.closed) throw new ImageProcessingError('Image processing is shut down');
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>(resolve => { release = resolve; });
        try {
            await previous;
            if (this.closed) throw new ImageProcessingError('Image processing is shut down');
            // A deadline that passed while waiting aborts before decoding.
            options.checkpoint?.('admission');
            return await imageImplementations.processImageBytes(bytes, mimeType, options);
        } finally {
            release();
        }
    }

    /** Refuse new and waiting requests; one being processed finishes. */
    dispose(): void {
        this.closed = true;
    }
}
