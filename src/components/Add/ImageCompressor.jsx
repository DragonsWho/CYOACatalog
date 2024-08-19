// src/components/Add/ImageCompressor.jsx
// v2.2
// Changes: Centered crop button, used theme color, fixed crop area sizing

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { Button, Typography, Box, CircularProgress, Alert } from '@mui/material';
import { useTheme } from '@mui/material/styles';

const aspectRatio = 3 / 4;
const maxWidth = 600; // Maximum width for initial resize

const ImageCompressor = ({
    onImageChange,
    buttonText = 'Upload Image',
    quality = 0.8
}) => {
    const theme = useTheme();
    const [isCompressing, setIsCompressing] = useState(false);
    const [error, setError] = useState(null);
    const [preview, setPreview] = useState(null);
    const [fileInfo, setFileInfo] = useState(null);
    const [image, setImage] = useState(null);
    const [crop, setCrop] = useState({ y: 0 });
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
    const canvasRef = useRef(null);
    const imageRef = useRef(null);
    const cropAreaRef = useRef(null);

    useEffect(() => {
        if (image && canvasRef.current) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) {
                    height = (maxWidth / width) * height;
                    width = maxWidth;
                }
                canvas.width = width;
                canvas.height = height;
                setCanvasSize({ width, height });
                ctx.drawImage(img, 0, 0, width, height);
                imageRef.current = img;
                setCrop({ y: 0 });
            };
            img.src = image;
        }
    }, [image]);

    const handleImageChange = useCallback(async (event) => {
        const file = event.target.files[0];
        if (file) {
            setIsCompressing(true);
            setError(null);
            try {
                const reader = new FileReader();
                reader.onload = (e) => {
                    setImage(e.target.result);
                    setFileInfo({
                        originalSize: file.size,
                    });
                };
                reader.readAsDataURL(file);
            } catch (error) {
                console.error('Error processing image:', error);
                setError('Failed to process image. Please try again.');
            } finally {
                setIsCompressing(false);
            }
        }
    }, []);

    const handleCrop = useCallback(() => {
        if (imageRef.current && canvasRef.current) {
            const canvas = document.createElement('canvas');
            const cropWidth = canvasSize.width;
            const cropHeight = cropWidth / aspectRatio;
            canvas.width = cropWidth;
            canvas.height = cropHeight;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(
                canvasRef.current,
                0,
                crop.y,
                cropWidth,
                cropHeight,
                0,
                0,
                canvas.width,
                canvas.height
            );

            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        const croppedImageUrl = URL.createObjectURL(blob);
                        setPreview(croppedImageUrl);
                        setFileInfo(prevState => ({
                            ...prevState,
                            compressedSize: blob.size
                        }));
                        const compressedFile = new File([blob], 'cropped_image.jpg', { type: 'image/jpeg' });
                        onImageChange(compressedFile);
                    }
                },
                'image/jpeg',
                quality
            );
        }
    }, [crop, quality, onImageChange, canvasSize]);

    const handleMouseDown = useCallback((e) => {
        const startY = e.clientY;
        const startTop = crop.y;
        const maxY = canvasSize.height - (canvasSize.width / aspectRatio);

        const handleMouseMove = (moveEvent) => {
            const deltaY = moveEvent.clientY - startY;
            setCrop(prevCrop => ({
                y: Math.max(0, Math.min(startTop + deltaY, maxY))
            }));
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [crop, canvasSize]);

    const handleRemoveImage = () => {
        setImage(null);
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
                    Processing image...
                </Typography>
            )}
            {error && (
                <Alert severity="error" sx={{ mt: 1 }}>
                    {error}
                </Alert>
            )}
            {image && !preview && (
                <Box sx={{ mt: 2, position: 'relative' }}>
                    <Button
                        onClick={handleCrop}
                        sx={{
                            position: 'absolute',
                            top: crop.y - 40, // Positioned above the crop area
                            left: '50%',
                            transform: 'translateX(-50%)', // Center the button
                            zIndex: 1,
                            backgroundColor: theme.palette.primary.main,
                            color: theme.palette.primary.contrastText,
                            '&:hover': {
                                backgroundColor: theme.palette.primary.dark,
                            }
                        }}
                    >
                        Crop
                    </Button>
                    <canvas
                        ref={canvasRef}
                        style={{ maxWidth: '100%' }}
                    />
                    <div
                        ref={cropAreaRef}
                        style={{
                            position: 'absolute',
                            top: crop.y,
                            left: 0,
                            width: '100%',
                            height: `${(canvasSize.width / aspectRatio / canvasSize.height) * 100}%`,
                            border: '2px solid white',
                            boxShadow: '0 0 0 9999em rgba(0, 0, 0, 0.5)',
                            cursor: 'ns-resize'
                        }}
                        onMouseDown={handleMouseDown}
                    />
                </Box>
            )}
            {preview && (
                <Box sx={{ mt: 2 }}>
                    <Typography variant="h6">Preview:</Typography>
                    <img
                        src={preview}
                        alt="Preview"
                        style={{
                            maxWidth: '100%',
                            maxHeight: '300px',
                            objectFit: 'contain'
                        }}
                    />
                    {fileInfo && (
                        <Typography variant="body2" sx={{ mt: 1 }}>
                            Original size: {(fileInfo.originalSize / 1024).toFixed(2)} KB
                            <br />
                            {fileInfo.compressedSize && `Compressed size: ${(fileInfo.compressedSize / 1024).toFixed(2)} KB`}
                        </Typography>
                    )}
                    <Button onClick={handleRemoveImage} sx={{ mt: 1 }}>
                        Remove Image
                    </Button>
                </Box>
            )}
        </Box>
    );
};

export default ImageCompressor;