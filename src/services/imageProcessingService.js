// src/services/imageProcessingService.js
// v1.0
// New file: Image processing service for client-side compression and conversion to AVIF

import { ImagePool } from '@squoosh/lib'
import { cpus } from 'os'

const imagePool = new ImagePool(cpus().length)

export const processImage = async (file, maxWidth = 1920, maxHeight = 1080) => {
    const image = imagePool.ingestImage(file)

    // Resize the image if it's larger than the specified dimensions
    const { bitmap } = await image.decoded
    const resizeOptions = {
        width: Math.min(bitmap.width, maxWidth),
        height: Math.min(bitmap.height, maxHeight),
    }

    await image.preprocess(resizeOptions)

    // Encode the image to AVIF format
    const encodeOptions = {
        avif: {
            cqLevel: 33,
            cqAlphaLevel: -1,
            denoiseLevel: 0,
            tileColsLog2: 0,
            tileRowsLog2: 0,
            speed: 6,
            subsample: 1,
            chromaDeltaQ: false,
            sharpness: 0,
            tune: 0
        }
    }

    await image.encode(encodeOptions)

    const { binary } = await image.encodedWith.avif

    // Create a new File object with the processed image
    const processedFile = new File([binary], file.name.replace(/\.[^/.]+$/, '.avif'), {
        type: 'image/avif'
    })

    return processedFile
}