// src/components/Add/ImageCompressor.jsx
// v1.0
// New component: Image compressor using browser's ImageBitmap and Canvas API

import React, { useCallback } from 'react';
import { Button, Typography, Box } from '@mui/material';

const ImageCompressor = ({ onImageChange, buttonText = 'Upload Image', maxWidth = 1920, maxHeight = 1080, quality = 0.8 }) => {
    const compressImage = useCallback(async (file) => {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        let width = bitmap.width;
        let height = bitmap.height;

        if (width > maxWidth) {
            height = (maxWidth / width) * height;
            width = maxWidth;
        }

        if (height > maxHeight) {
            width = (maxHeight / height) * width;
            height = maxHeight;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);

        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                resolve(new File([blob], file.name, {
                    type: 'image/jpeg',
                    lastModified: Date.now()
                }));
            }, 'image/jpeg', quality);
        });
    }, [maxWidth, maxHeight, quality]);

    const handleImageChange = useCallback(async (event) => {
        const file = event.target.files[0];
        if (file) {
            try {
                const compressedImage = await compressImage(file);
                onImageChange(compressedImage);
            } catch (error) {
                console.error('Error compressing image:', error);
                // You might want to handle this error more gracefully
            }
        }
    }, [compressImage, onImageChange]);

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
                <Button variant="contained" component="span">
                    {buttonText}
                </Button>
            </label>
        </Box>
    );
};

export default ImageCompressor;