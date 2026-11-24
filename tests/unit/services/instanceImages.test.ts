import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ImageProcessingError,
    imageImplementations,
    type ProcessImageOptions,
    type ProcessedImage,
} from '../../../src/services/images/imageProcessing';
import { InstanceImages } from '../../../src/services/images/instanceImages';

function options(overrides: Partial<ProcessImageOptions> = {}): ProcessImageOptions {
    return { maxWidth: 100, maxHeight: 100, format: 'auto', jpegQuality: 85, maxOutputBytes: 1000, ...overrides };
}

function result(tag: number): ProcessedImage {
    return {
        data: new Uint8Array([tag]),
        format: 'png',
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        sourceMime: 'image/png',
        resized: false,
        converted: false,
    };
}

/** A promise with its resolve/reject exposed. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('InstanceImages', () => {
    let impl: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        impl = vi.spyOn(imageImplementations, 'processImageBytes');
    });

    it('processes one image at a time, in arrival order', async () => {
        const first = deferred<ProcessedImage>();
        const second = deferred<ProcessedImage>();
        impl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const images = new InstanceImages();

        const a = images.process(new Uint8Array([1]), 'image/png', options());
        const b = images.process(new Uint8Array([2]), 'image/png', options());
        await flush();
        expect(impl).toHaveBeenCalledTimes(1);

        first.resolve(result(1));
        await expect(a).resolves.toEqual(result(1));
        await flush();
        expect(impl).toHaveBeenCalledTimes(2);
        expect((impl.mock.calls[1][0] as Uint8Array)[0]).toBe(2);

        second.resolve(result(2));
        await expect(b).resolves.toEqual(result(2));
    });

    it('admits the next image after one fails', async () => {
        impl.mockRejectedValueOnce(new Error('decode failure')).mockResolvedValueOnce(result(2));
        const images = new InstanceImages();

        const a = images.process(new Uint8Array([1]), 'image/png', options());
        const b = images.process(new Uint8Array([2]), 'image/png', options());

        await expect(a).rejects.toThrow('decode failure');
        await expect(b).resolves.toEqual(result(2));
    });

    it('checks the deadline on admission, before decoding', async () => {
        const first = deferred<ProcessedImage>();
        impl.mockReturnValueOnce(first.promise);
        const images = new InstanceImages();
        const timedOut = new Error('timed out');
        const checkpoint = vi.fn((phase: string) => {
            if (phase === 'admission' && checkpoint.mock.calls.length > 1) throw timedOut;
        });

        const a = images.process(new Uint8Array([1]), 'image/png', options({ checkpoint }));
        const b = images.process(new Uint8Array([2]), 'image/png', options({ checkpoint }));
        first.resolve(result(1));

        await expect(a).resolves.toEqual(result(1));
        await expect(b).rejects.toBe(timedOut);
        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('refuses new and waiting images after dispose, letting the active one finish', async () => {
        const first = deferred<ProcessedImage>();
        impl.mockReturnValueOnce(first.promise);
        const images = new InstanceImages();

        const a = images.process(new Uint8Array([1]), 'image/png', options());
        const b = images.process(new Uint8Array([2]), 'image/png', options());
        await flush();
        images.dispose();
        first.resolve(result(1));

        await expect(a).resolves.toEqual(result(1));
        await expect(b).rejects.toBeInstanceOf(ImageProcessingError);
        await expect(images.process(new Uint8Array([3]), 'image/png', options())).rejects.toBeInstanceOf(ImageProcessingError);
        expect(impl).toHaveBeenCalledTimes(1);
    });
});
