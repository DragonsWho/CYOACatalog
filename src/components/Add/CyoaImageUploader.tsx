// src/components/Add/CyoaImageUploader.tsx
// Version 1.4.0
// Changes: Removed immediate image processing, added function to get images for upload

import React, { useState, useCallback } from 'react';
import { Box, Button, Typography, List, ListItem, ListItemText, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';

interface CyoaImageUploaderProps {
  onImagesChange: (files: File[]) => void;
  getImages: () => File[];
}

interface ImageItem {
  file: File;
  preview: string;
}

const CyoaImageUploader: React.FC<CyoaImageUploaderProps> = ({ onImagesChange }) => {
  const [images, setImages] = useState<ImageItem[]>([]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    setImages((prevImages) => [...prevImages, ...newImages]);
    onImagesChange([...images, ...newImages].map((img) => img.file));
  };

  const handleDragStart = (e: React.DragEvent<HTMLLIElement>, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDragOver = (e: React.DragEvent<HTMLLIElement>) => {
    e.preventDefault();
  };

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLLIElement>, dropIndex: number) => {
      e.preventDefault();
      const dragIndex = Number(e.dataTransfer.getData('text/plain'));
      const newImages = [...images];
      const [reorderedItem] = newImages.splice(dragIndex, 1);
      newImages.splice(dropIndex, 0, reorderedItem);
      setImages(newImages);
      onImagesChange(newImages.map((img) => img.file));
    },
    [images, onImagesChange],
  );

  const removeImage = useCallback(
    (index: number) => {
      const newImages = images.filter((_, i) => i !== index);
      setImages(newImages);
      onImagesChange(newImages.map((img) => img.file));
    },
    [images, onImagesChange],
  );

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
            secondaryAction={
              <IconButton edge="end" aria-label="delete" onClick={() => removeImage(index)}>
                <DeleteIcon />
              </IconButton>
            }
          >
            <DragIndicatorIcon sx={{ mr: 2 }} />
            <img
              src={image.preview}
              alt={`CYOA page ${index + 1}`}
              style={{ width: 50, height: 50, marginRight: 10 }}
            />
            <ListItemText primary={`Page ${index + 1}`} secondary={image.file.name} />
          </ListItem>
        ))}
      </List>
      {images.length > 0 && (
        <Typography sx={{ mt: 1 }}>{images.length} image(s) uploaded. Drag and drop to reorder.</Typography>
      )}
    </Box>
  );
};

export default CyoaImageUploader;
