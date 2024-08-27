// src/components/CyoaPage/GameContent.tsx
// v2.5
// Fixed TypeScript errors and improved type safety

import React, { useState, useEffect } from 'react'

const API_URL = process.env.REACT_APP_API_URL || 'https://cyoa.cafe'

interface GameAttributes {
    img_or_link: 'img' | 'link';
    CYOA_pages?: {
        data: Array<{
            id: number;
            attributes: {
                url: string;
            };
        }>;
    };
    iframe_url?: string;
}

interface GameContentProps {
    attributes: GameAttributes;
    expanded: boolean;
    onExpand: (expanded: boolean) => void;
}

interface ImageSizes {
    [key: number]: {
        width: number;
        height: number;
    };
}

const GameContent: React.FC<GameContentProps> = ({ attributes, expanded, onExpand }) => {
    const [loadingImages, setLoadingImages] = useState(attributes.CYOA_pages?.data?.length || 0)
    const [imageErrors, setImageErrors] = useState<{ [key: number]: boolean }>({})
    const [imageSizes, setImageSizes] = useState<ImageSizes>({})
    const [iframeStyle, setIframeStyle] = useState<React.CSSProperties>({})

    useEffect(() => {
        if (attributes.img_or_link === 'link') {
            if (expanded) {
                setIframeStyle({
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    width: '100vw',
                    height: '100vh',
                    zIndex: 9999,
                })
            } else {
                setIframeStyle({
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                })
            }
        }
    }, [expanded, attributes.img_or_link])

    const handleImageLoad = (id: number, event: React.SyntheticEvent<HTMLImageElement, Event>) => {
        setLoadingImages((prev) => prev - 1)
        setImageSizes((prev) => ({
            ...prev,
            [id]: {
                width: (event.target as HTMLImageElement).naturalWidth,
                height: (event.target as HTMLImageElement).naturalHeight,
            },
        }))
    }

    const handleImageError = (id: number) => {
        setImageErrors((prev) => ({ ...prev, [id]: true }))
        setLoadingImages((prev) => prev - 1)
    }

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
        <div style={{ backgroundColor: '#121212' }}>
            {attributes.img_or_link === 'img' && attributes.CYOA_pages?.data ? (
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
                        {loadingImages > 0 && <div>Loading...</div>}
                        {attributes.CYOA_pages.data.map((image, index) => (
                            <div
                                key={image.id}
                                style={{
                                    width: '100%',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    backgroundColor: '#121212',
                                    transition: 'all 0.3s ease',
                                }}
                            >
                                {!imageErrors[image.id] && (
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
                                            display: loadingImages > 0 ? 'none' : 'block',
                                            transition: 'all 0.3s ease',
                                        }}
                                        onLoad={(event) => handleImageLoad(image.id, event)}
                                        onError={() => handleImageError(image.id)}
                                    />
                                )}
                                {imageErrors[image.id] && (
                                    <div style={{ color: 'red' }}>Failed to load image {index + 1}</div>
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
                        paddingBottom: expanded ? '0' : '56.25%', // 16:9 aspect ratio when not expanded
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