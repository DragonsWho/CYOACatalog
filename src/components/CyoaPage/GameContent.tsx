// src/components/CyoaPage/GameContent.tsx
// v3.4
// Enhanced error handling in loadImages function

import React, { useState, useEffect, useCallback } from 'react'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.cyoa.cafe'

interface GameAttributes {
    img_or_link: 'img' | 'link'
    CYOA_pages?: {
        data: Array<{
            id: number
            attributes: {
                url: string
                name: string
            }
        }>
    }
    iframe_url?: string
}

interface GameContentProps {
    attributes: GameAttributes
    expanded: boolean
    onExpand: (expanded: boolean) => void
}

interface ImageSizes {
    [key: number]: {
        width: number
        height: number
    }
}

const PLACEHOLDER_HEIGHT = 800 // Height of the placeholder in pixels
const MAX_RETRIES = 3 // Maximum number of retries for loading an image

const GameContent: React.FC<GameContentProps> = ({ attributes, expanded, onExpand }) => {
    const [imageErrors, setImageErrors] = useState<{ [key: number]: boolean }>({})
    const [imageSizes, setImageSizes] = useState<ImageSizes>({})
    const [iframeStyle, setIframeStyle] = useState<React.CSSProperties>({})
    const [sortedImages, setSortedImages] = useState(attributes.CYOA_pages?.data || [])
    const [loadedImages, setLoadedImages] = useState<number[]>([])
    const [isLoading, setIsLoading] = useState(false)

    useEffect(() => {
        if (attributes.img_or_link === 'link') {
            setIframeStyle(
                expanded
                    ? {
                          position: 'fixed',
                          top: 0,
                          left: 0,
                          width: '100vw',
                          height: '100vh',
                          zIndex: 9999,
                      }
                    : {
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: '100%',
                      },
            )
        }

        if (attributes.CYOA_pages?.data) {
            const sorted = [...attributes.CYOA_pages.data].sort((a, b) =>
                a.attributes.name.localeCompare(b.attributes.name, undefined, { numeric: true, sensitivity: 'base' }),
            )
            setSortedImages(sorted)
        }
    }, [expanded, attributes.img_or_link, attributes.CYOA_pages?.data])

    const loadImage = useCallback((image: (typeof sortedImages)[0], retryCount = 0): Promise<void> => {
        return new Promise((resolve, reject) => {
            console.log(
                `Attempting to load image: ${image.attributes.name} (Attempt ${retryCount + 1}/${MAX_RETRIES + 1})`,
            )
            const img = new Image()
            img.src = `${API_URL}${image.attributes.url}`

            img.onload = () => {
                console.log(`Successfully loaded image: ${image.attributes.name}`)
                setLoadedImages((prev) => [...prev, image.id])
                setImageSizes((prev) => ({
                    ...prev,
                    [image.id]: {
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                    },
                }))
                resolve()
            }

            img.onerror = () => {
                console.error(`Failed to load image: ${image.attributes.name}`)
                if (retryCount < MAX_RETRIES) {
                    console.log(`Retrying image: ${image.attributes.name}`)
                    setTimeout(() => {
                        loadImage(image, retryCount + 1)
                            .then(resolve)
                            .catch(reject)
                    }, 1000)
                } else {
                    console.error(`Max retries reached for image: ${image.attributes.name}`)
                    setImageErrors((prev) => ({ ...prev, [image.id]: true }))
                    reject(new Error(`Failed to load image: ${image.attributes.name}`))
                }
            }
        })
    }, [])

    const loadImages = useCallback(async () => {
        setIsLoading(true)
        for (const image of sortedImages) {
            if (!loadedImages.includes(image.id)) {
                try {
                    await loadImage(image)
                } catch (error) {
                    if (error instanceof Error) {
                        console.error(`Error loading image: ${error.message}`)
                    } else {
                        console.error(`An unknown error occurred while loading image: ${image.attributes.name}`)
                    }
                    setImageErrors((prev) => ({ ...prev, [image.id]: true }))
                }
            }
        }
        setIsLoading(false)
    }, [sortedImages, loadedImages, loadImage])

    useEffect(() => {
        if (sortedImages.length > 0 && !isLoading) {
            loadImages()
        }
    }, [sortedImages, loadImages, isLoading])

    const collapseButtonStyle: React.CSSProperties = {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 10000,
        padding: '10px 20px',
        backgroundColor: '#007bff',
        color: 'white',
        border: 'none',
        borderRadius: '5px',
        cursor: 'pointer',
    }

    return (
        <div style={{ backgroundColor: '#121212', overflowY: 'auto' }}>
            {attributes.img_or_link === 'img' && sortedImages.length > 0 ? (
                <div>
                    <div
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '1rem',
                            transition: 'all 0.3s ease',
                        }}
                    >
                        {sortedImages.map((image, index) => (
                            <div
                                key={image.id}
                                style={{
                                    width: '100%',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    backgroundColor: '#121212',
                                    transition: 'all 0.3s ease',
                                    height: loadedImages.includes(image.id) ? 'auto' : `${PLACEHOLDER_HEIGHT}px`,
                                }}
                            >
                                {loadedImages.includes(image.id) && !imageErrors[image.id] ? (
                                    <img
                                        src={`${API_URL}${image.attributes.url}`}
                                        alt={`Game content ${index + 1}`}
                                        style={{
                                            maxWidth: expanded ? 'none' : '100%',
                                            width: expanded
                                                ? 'auto'
                                                : imageSizes[image.id]?.width > window.innerWidth
                                                ? '100%'
                                                : 'auto',
                                            height: 'auto',
                                            transition: 'all 0.3s ease',
                                        }}
                                    />
                                ) : imageErrors[image.id] ? (
                                    <div style={{ color: 'red' }}>Failed to load image {index + 1}</div>
                                ) : (
                                    <div style={{ color: '#666', fontSize: '14px' }}>Loading image {index + 1}...</div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ) : attributes.img_or_link === 'link' && attributes.iframe_url ? (
                <div
                    style={{
                        width: '100%',
                        height: 0,
                        paddingBottom: expanded ? '0' : '56.25%',
                        position: 'relative',
                        overflow: 'hidden',
                    }}
                >
                    <iframe
                        src={attributes.iframe_url}
                        style={iframeStyle}
                        title="Game content"
                        allowFullScreen
                        loading="lazy"
                    />
                    {expanded && (
                        <button style={collapseButtonStyle} onClick={() => onExpand(false)}>
                            Collapse
                        </button>
                    )}
                </div>
            ) : (
                <div>No game content available</div>
            )}
        </div>
    )
}

export default GameContent
