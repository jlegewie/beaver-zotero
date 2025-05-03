
async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function uint8ArrayToBase64(uint8Array: Uint8Array) {
    // Convert Uint8Array to binary string
    let binaryString = '';
    for (let i = 0; i < uint8Array.length; i++) {
        binaryString += String.fromCharCode(uint8Array[i]);
    }
    
    // Encode binary string to base64
    return btoa(binaryString);
}

/**
 * Optimizes an image by applying a scale factor to its dimensions
 * 
 * @param imagePath Path to the image file
 * @param scaleFactor Factor to scale the image dimensions (0.5 = half size, 0.75 = 75% of original size)
 * @param quality JPEG quality (0.0-1.0) where higher is better quality but larger file size
 * @returns Base64 string of the optimized image
 */
async function optimizeImageByScale(
    imagePath: string, 
    scaleFactor: number = 0.75,
    quality: number = 0.85
): Promise<string> {
    try {
        // Read the image file
        const imageData = await IOUtils.read(imagePath);
        const blob = new Blob([imageData], { type: 'image/png' });
        const imageUrl = URL.createObjectURL(blob);
        
        return new Promise<string>((resolve, reject) => {
            const img = new Image();
            
            img.onload = () => {
                // Calculate new dimensions based on scale factor
                const width = Math.round(img.width * scaleFactor);
                const height = Math.round(img.height * scaleFactor);
                
                // Create canvas for resizing
                const canvas = Zotero.getMainWindow().document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                
                // Draw the image
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(imageUrl);
                    reject(new Error("Could not get canvas context"));
                    return;
                }
                
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);
                
                // Convert to JPEG with specified quality
                const optimizedBase64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
                
                // Log original vs new size for debugging
                const originalSizeKB = imageData.byteLength / 1024;
                const optimizedSizeKB = optimizedBase64.length * 0.75 / 1024;
                console.log(`Image scaled by ${scaleFactor}: ${originalSizeKB.toFixed(1)}KB → ${optimizedSizeKB.toFixed(1)}KB`);
                
                // Clean up
                URL.revokeObjectURL(imageUrl);
                resolve(optimizedBase64);
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(imageUrl);
                reject(new Error("Failed to load image"));
            };
            
            img.src = imageUrl;
        });
    } catch (error) {
        console.error("Image optimization error:", error);
        // Fallback to original image if optimization fails
        const originalData = await IOUtils.read(imagePath);
        return uint8ArrayToBase64(originalData);
    }
}

export { fileToBase64, uint8ArrayToBase64, optimizeImageByScale };