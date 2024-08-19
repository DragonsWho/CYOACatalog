// src/components/Add/ImageCompressor.jsx
// v1.3
import React, { useCallback, useState } from 'react';
import { Button, Typography, Box, CircularProgress, Alert } from '@mui/material';

const ImageCompressor = ({ onImageChange, buttonText = 'Upload Image', maxWidth = 1920, maxHeight = 1080, quality = 0.8 }) => {
    const [isCompressing, setIsCompressing] = useState(false);
    const [error, setError] = useState(null);
    const [preview, setPreview] = useState(null);
    const [fileInfo, setFileInfo] = useState(null);

    const compressImage = useCallback(async (file) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, ".webp"), {
                                type: 'image/webp',
                                lastModified: Date.now()
                            });
                            setPreview(URL.createObjectURL(compressedFile));
                            setFileInfo({
                                originalSize: file.size,
                                compressedSize: blob.size
                            });
                            resolve(compressedFile);
                        } else {
                            reject(new Error('Canvas to Blob conversion failed'));
                        }
                    },
                    'image/webp',
                    quality
                );
            };
            img.onerror = (error) => reject(error);
            img.src = URL.createObjectURL(file);
        });
    }, [maxWidth, maxHeight, quality]);

    const handleImageChange = useCallback(async (event) => {
        const file = event.target.files[0];
        if (file) {
            setIsCompressing(true);
            setError(null);
            try {
                const compressedImage = await compressImage(file);
                setTimeout(() => {
                    onImageChange(compressedImage);
                }, 100);
            } catch (error) {
                console.error('Error compressing image:', error);
                setError('Failed to compress image. Please try again.');
            } finally {
                setIsCompressing(false);
            }
        }
    }, [compressImage, onImageChange]);

    const handleRemoveImage = () => {
        setPreview(null);
        setFileInfo(null);
        onImageChange(null);
    };

    return (
        <Box>
            <input
                accept="image/*"
                id="image-upload"
                type="file"
                onChange={handleImageChange}
                style={{ display: 'none' }}
            />
            <label htmlFor="image-upload">
                <Button variant="contained" component="span" disabled={isCompressing}>
                    {isCompressing ? <CircularProgress size={24} /> : buttonText}
                </Button>
            </label>
            {isCompressing && (
                <Typography variant="body2" sx={{ mt: 1 }}>
                    Compressing image...
                </Typography>
            )}
            {error && (
                <Alert severity="error" sx={{ mt: 1 }}>
                    {error}
                </Alert>
            )}
            {preview && (
                <Box sx={{ mt: 2 }}>
                    <img src={preview} alt="Preview" style={{ maxWidth: '100%', maxHeight: '200px' }} />
                    <Typography variant="body2" sx={{ mt: 1 }}>
                        Original size: {(fileInfo.originalSize / 1024).toFixed(2)} KB
                        <br />
                        Compressed size: {(fileInfo.compressedSize / 1024).toFixed(2)} KB
                    </Typography>
                    <Button onClick={handleRemoveImage} sx={{ mt: 1 }}>
                        Remove Image
                    </Button>
                </Box>
            )}
        </Box>
    );
};

export default ImageCompressor;