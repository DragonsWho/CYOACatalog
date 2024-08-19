// src/components/Add/ImageCompressor.jsx
// v1.7
// Changes: Fixed resizing and cropping logic to start from the top

import React, { useCallback, useState } from 'react';
import { Button, Typography, Box, CircularProgress, Alert } from '@mui/material';

// START: Aspect Ratio Configuration
// You can easily change the aspect ratio by modifying this value
// Examples: 1 (square), 4/3, 16/9, 2/3 (portrait), etc.
const defaultAspectRatio = 3/4; // Square aspect ratio
// END: Aspect Ratio Configuration

const ImageCompressor = ({
    onImageChange,
    buttonText = 'Upload Image',
    quality = 0.8,
    aspectRatio = defaultAspectRatio,
    targetWidth = 500
}) => {
    const [isCompressing, setIsCompressing] = useState(false);
    const [error, setError] = useState(null);
    const [preview, setPreview] = useState(null);
    const [fileInfo, setFileInfo] = useState(null);

    const compressImage = useCallback(async (file) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = targetWidth;
                let height = Math.round(targetWidth / aspectRatio);

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');

                // Calculate scaling factor
                const scale = width / img.width;
                const scaledHeight = img.height * scale;

                // Draw the resized image
                ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, width, scaledHeight);

                // Crop from the top
                const imageData = ctx.getImageData(0, 0, width, height);
                canvas.width = width;
                canvas.height = height;
                ctx.putImageData(imageData, 0, 0);

                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, ".jpg"), {
                                type: 'image/jpeg',
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
                    'image/jpeg',
                    quality
                );
            };
            img.onerror = (error) => reject(error);
            img.src = URL.createObjectURL(file);
        });
    }, [quality, aspectRatio, targetWidth]);

    const handleImageChange = useCallback(async (event) => {
        const file = event.target.files[0];
        if (file) {
            setIsCompressing(true);
            setError(null);
            try {
                const compressedImage = await compressImage(file);
                onImageChange(compressedImage);
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
                    <img
                        src={preview}
                        alt="Preview"
                        style={{
                            width: '200px',
                            height: `${200 / aspectRatio}px`,
                            objectFit: 'cover'
                        }}
                    />
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