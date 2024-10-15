import { PixelCrop } from 'react-image-crop'
import { CanvasPreview } from './CanvasPreview'

let previewUrl = ''

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve)
  })
}

// Returns an image source you should set to state and pass
// `{previewSrc && <img alt="Crop preview" src={previewSrc} />}`
export async function ImgPreview(
  image: HTMLImageElement,
  crop: PixelCrop
) {
  const canvas = document.createElement('canvas')
  CanvasPreview(image, canvas, crop)

  const blob = await toBlob(canvas)

  if (!blob) {
    console.error('Failed to create blob')
    return ''
  }

  if (previewUrl) {
    URL.revokeObjectURL(previewUrl)
  }

  previewUrl = URL.createObjectURL(blob)
  return previewUrl
}
