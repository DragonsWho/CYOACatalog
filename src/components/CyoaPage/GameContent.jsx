// src/components/CyoaPage/GameContent.jsx
// v1.8
// Simplified lightbox with scrollable content

import React, { useState } from 'react';

const API_URL = 'http://localhost:1337';

const GameContent = ({ attributes }) => {
    const [loadingImages, setLoadingImages] = useState(attributes.CYOA_pages?.data?.length || 0);
    const [imageErrors, setImageErrors] = useState({});
    const [lightboxOpen, setLightboxOpen] = useState(false);

    const handleImageLoad = (id) => {
        setLoadingImages(prev => prev - 1);
    };

    const handleImageError = (id) => {
        setImageErrors(prev => ({ ...prev, [id]: true }));
        setLoadingImages(prev => prev - 1);
    };

    const modalStyles = {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        overflowY: 'auto',
        zIndex: 1000,
    };

    const modalContentStyles = {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '20px',
    };

    const closeButtonStyles = {
        position: 'fixed',
        top: '10px',
        right: '10px',
        background: 'none',
        border: 'none',
        color: 'white',
        fontSize: '1.5rem',
        cursor: 'pointer',
        zIndex: 1001,
    };

    return (
        <div style={{ backgroundColor: '#121212' }}>
            {attributes.img_or_link === 'img' && attributes.CYOA_pages?.data ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
                    {loadingImages > 0 && <div>Loading...</div>}
                    {attributes.CYOA_pages.data.map((image, index) => (
                        <div
                            key={image.id}
                            style={{
                                width: '100%',
                                display: 'flex',
                                justifyContent: 'center',
                                backgroundColor: '#121212'
                            }}
                        >
                            {!imageErrors[image.id] && (
                                <img
                                    src={`${API_URL}${image.attributes.url}`}
                                    alt={`Game content ${index + 1}`}
                                    style={{
                                        maxWidth: '100%',
                                        height: 'auto',
                                        display: loadingImages > 0 ? 'none' : 'block',
                                        cursor: 'pointer'
                                    }}
                                    onLoad={() => handleImageLoad(image.id)}
                                    onError={() => handleImageError(image.id)}
                                    onClick={() => setLightboxOpen(true)}
                                />
                            )}
                            {imageErrors[image.id] && (
                                <div style={{ color: 'red' }}>
                                    Failed to load image {index + 1}
                                </div>
                            )}
                        </div>
                    ))}
                    {lightboxOpen && (
                        <div style={modalStyles}>
                            <button
                                onClick={() => setLightboxOpen(false)}
                                style={closeButtonStyles}
                            >
                                ✕
                            </button>
                            <div style={modalContentStyles}>
                                {attributes.CYOA_pages.data.map((image, index) => (
                                    <img
                                        key={image.id}
                                        src={`${API_URL}${image.attributes.url}`}
                                        alt={`Game content ${index + 1}`}
                                        style={{
                                            maxWidth: '90%',
                                            height: 'auto',
                                            marginBottom: '20px'
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            ) : attributes.img_or_link === 'link' && attributes.iframe_url ? (
                <div style={{
                    width: '100%',
                    height: 0,
                    paddingBottom: '56.25%', // 16:9 aspect ratio
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <iframe
                        src={attributes.iframe_url}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            border: 'none'
                        }}
                        title="Game content"
                        allowFullScreen
                        loading="lazy"
                    />
                </div>
            ) : (
                <div>No game content available</div>
            )}
        </div>
    );
};

export default GameContent;