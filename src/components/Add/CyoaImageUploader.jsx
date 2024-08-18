// src/components/Add/CyoaImageUploader.jsx
// Version 1.0.0
// New component for uploading and sorting CYOA images

import React, { useState, useCallback } from 'react';
import { Box, Button, Typography, List, ListItem, ListItemText, ListItemSecondaryAction, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';

const CyoaImageUploader = ({ onImagesChange }) => {
    const [images, setImages] = useState([]);

    const handleFileChange = (event) => {
        const newImages = Array.from(event.target.files).map(file => ({
            file,
            preview: URL.createObjectURL(file)
        }));
        setImages(prevImages => [...prevImages, ...newImages]);
        onImagesChange([...images, ...newImages].map(img => img.file));
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