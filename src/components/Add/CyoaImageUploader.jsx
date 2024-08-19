// src/components/Add/CyoaImageUploader.jsx
// Version 1.1.0
import React, { useState, useCallback } from 'react';
import { Box, Button, Typography, List, ListItem, ListItemText, ListItemSecondaryAction, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';

const CyoaImageUploader = ({ onImagesChange }) => {
    const [images, setImages] = useState([]);

    const compressImage = useCallback(async (file) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const maxWidth = 1920;
                const maxHeight = 1080;

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
                            const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, ".jpg"), {
                                type: 'image/jpeg',
                                lastModified: Date.now()
                            });
                            resolve(compressedFile);
                        } else {
                            reject(new Error('Canvas to Blob conversion failed'));
                        }
                    },
                    'image/jpeg',
                    0.8
                );
            };
            img.onerror = (error) => reject(error);
            img.src = URL.createObjectURL(file);
        });
    }, []);

    const handleFileChange = async (event) => {
        const files = Array.from(event.target.files);
        const compressedImages = await Promise.all(files.map(async (file) => {
            const compressedFile = await compressImage(file);
            return {
                file: compressedFile,
                preview: URL.createObjectURL(compressedFile)
            };
        }));
        setImages(prevImages => [...prevImages, ...compressedImages]);
        onImagesChange([...images, ...compressedImages].map(img => img.file));
    };

    const handleDragStart = (e, index) => {
        e.dataTransfer.setData('text/plain', index);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
    };

    const handleDrop = useCallback((e, dropIndex) => {
        e.preventDefault();
        const dragIndex = Number(e.dataTransfer.getData('text/plain'));
        const newImages = [...images];
        const [reorderedItem] = newImages.splice(dragIndex, 1);
        newImages.splice(dropIndex, 0, reorderedItem);
        setImages(newImages);
        onImagesChange(newImages.map(img => img.file));
    }, [images, onImagesChange]);

    const removeImage = useCallback((index) => {
        const newImages = images.filter((_, i) => i !== index);
        setImages(newImages);
        onImagesChange(newImages.map(img => img.file));
    }, [images, onImagesChange]);

    return (
        <Box>
            <input
                accept="image/*"
                id="cyoa-images-upload"
                type="file"
                multiple
                onChange={handleFileChange}
                style={{ display: 'none' }}
            />
            <label htmlFor="cyoa-images-upload">
                <Button variant="contained" component="span">
                    Upload CYOA Page Images
                </Button>
            </label>
            <List>
                {images.map((image, index) => (
                    <ListItem
                        key={index}
                        draggable
                        onDragStart={(e) => handleDragStart(e, index)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, index)}
                        sx={{ cursor: 'move' }}
                    >
                        <DragIndicatorIcon sx={{ mr: 2 }} />
                        <img src={image.preview} alt={`CYOA page ${index + 1}`} style={{ width: 50, height: 50, marginRight: 10 }} />
                        <ListItemText primary={`Page ${index + 1}`} secondary={image.file.name} />
                        <ListItemSecondaryAction>
                            <IconButton edge="end" aria-label="delete" onClick={() => removeImage(index)}>
                                <DeleteIcon />
                            </IconButton>
                        </ListItemSecondaryAction>
                    </ListItem>
                ))}
            </List>
            {images.length > 0 && (
                <Typography sx={{ mt: 1 }}>
                    {images.length} image(s) uploaded. Drag and drop to reorder.
                </Typography>
            )}
        </Box>
    );
};

export default CyoaImageUploader;