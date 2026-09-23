import { PixelCrop } from 'react-image-crop'
import { CanvasPreview } from './CanvasPreview'

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve)
  })
}

// Returns an image src. Each call creates its own object URL (a shared module variable let call B
// revoke A's URL mid-display). Revoking is the caller's job (effect cleanup).
export async function ImgPreview(
  image: HTMLImageElement,
  crop: PixelCrop
): Promise<string> {
  const canvas = document.createElement('canvas')
  CanvasPreview(image, canvas, crop)

  const blob = await toBlob(canvas)

  if (!blob) {
    // Throws instead of returning '' so the caller can show the failure.
    throw new Error('Failed to create preview blob')
  }

  return URL.createObjectURL(blob)
}
