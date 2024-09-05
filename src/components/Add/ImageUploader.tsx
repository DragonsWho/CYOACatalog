// src/components/Add/ImageUploader.tsx
// Version 1.0
// New component: Image upload functionality

import React from 'react';
import { Box, Typography } from '@mui/material';
import ImageCompressor from './ImageCompressor';
import CyoaImageUploader from './CyoaImageUploader';

interface ImageUploaderProps {
    cardImage: File | null;
    setCardImage: (image: File) => void;
    cyoaImages: File[];
    setCyoaImages: (images: File[]) => void;
    imgOrLink: 'img' | 'link';
}

function ImageUploader({ cardImage, setCardImage, cyoaImages, setCyoaImages, imgOrLink }: ImageUploaderProps): JSX.Element {
    const handleCardImageChange = (compressedImage: File) => {
        setCardImage(compressedImage);
    };

    const handleCyoaImagesChange = (newImages: File[]) => {
        setCyoaImages(newImages);
    };

    return (
        <>
            <Box sx={{ mt: 2 }}>
                <ImageCompressor
                    onImageChange={handleCardImageChange}
                    buttonText="Upload Card Image"
                    maxWidth={800}
                    maxHeight={600}
                />
                {cardImage && (
                    <Typography sx={{ mt: 1 }}>
                        {cardImage.name} (Size: {(cardImage.size / 1024).toFixed(2)} KB)
                    </Typography>
                )}
            </Box>
            {imgOrLink === 'img' && (
                <Box sx={{ mt: 2 }}>
                    <CyoaImageUploader onImagesChange={handleCyoaImagesChange} getImages={() => cyoaImages} />
                </Box>
            )}
        </>
    );
}

export default ImageUploader;