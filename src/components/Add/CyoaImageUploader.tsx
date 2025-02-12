// src/components/Add/CyoaImageUploader.tsx
// Version 1.4.0
// Changes: Fixed the display of ImageSplitterIcon, now it is displayed next to the images that should be split. 

import React, { useEffect, useState } from 'react';
import { Box, Button, Typography, List, ListItem, ListItemText, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete'; 
import ContentCutIcon from '@mui/icons-material/ContentCut';

import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ImageSplitter from './ImageSplitter/ImageSpliter';
import { createPortal } from 'react-dom';

export default function CyoaImageUploader({
  onImagesChange,
  onNeedsSplitChange,
}: {
  onImagesChange: (files: File[]) => void;
  onNeedsSplitChange: (splitsNeeded: boolean) => void;
}) {
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  // array of booleans indicating whether a modal is being shown
  // for each image, realistically only one can show at once
  const [showModal, setShowModal] = useState<boolean[]>([]);
  // array of booleans indicating whether
  // each image needs to be split
  const [needsSplit, setNeedsSplit] = useState<boolean[]>([]);

  useEffect(() => {
    onNeedsSplitChange(needsSplit.some(x => x === true));
  }, [needsSplit, onNeedsSplitChange]);

  // Determines whether to split the image
  async function getNeedsSplit(file: File): Promise<boolean> {
    try {
      const image = await createImageBitmap(file);
      return image.height > 16383;
    } catch (e) {
      return false;
    }
  }

  // Updates the needsSplit state for all images
  async function updateNeedsSplitStates(files: File[]) {
    const splitStates = await Promise.all(files.map(file => getNeedsSplit(file)));
    setNeedsSplit(splitStates);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    const updatedImages = [...images, ...newImages];
    setImages(updatedImages);
    
    // Update modal window array
    setShowModal(new Array(updatedImages.length).fill(false));
    
    // Update needsSplit for all images
    await updateNeedsSplitStates(updatedImages.map(img => img.file));
    
    onImagesChange(updatedImages.map(img => img.file));
  }

  async function recreateImageArray(files: File[]) {
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    setImages(newImages);
    setShowModal(new Array(newImages.length).fill(false));
    
    // Update needsSplit for all images
    await updateNeedsSplitStates(files);
    
    onImagesChange(newImages.map(img => img.file));
  }

  async function handleDrop(e: React.DragEvent<HTMLLIElement>, dropIndex: number) {
    e.preventDefault();
    const dragIndex = Number(e.dataTransfer.getData('text/plain'));
    
    const newImages = [...images];
    const [reorderedItem] = newImages.splice(dragIndex, 1);
    newImages.splice(dropIndex, 0, reorderedItem);
    
    setImages(newImages);
    
    // Update needsSplit according to the new order
    const newNeedsSplit = [...needsSplit];
    const [reorderedSplit] = newNeedsSplit.splice(dragIndex, 1);
    newNeedsSplit.splice(dropIndex, 0, reorderedSplit);
    setNeedsSplit(newNeedsSplit);
    
    onImagesChange(newImages.map(img => img.file));
  }

  function handleDragStart(e: React.DragEvent<HTMLLIElement>, index: number) {
    e.dataTransfer.setData('text/plain', index.toString());
  }

  function handleDragOver(e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
  }

  function removeImage(index: number) {
    const newImages = images.filter((_, i) => i !== index);
    const newNeedsSplit = needsSplit.filter((_, i) => i !== index);
    const newShowModal = showModal.filter((_, i) => i !== index);
    
    setImages(newImages);
    setNeedsSplit(newNeedsSplit);
    setShowModal(newShowModal);
    
    onImagesChange(newImages.map(img => img.file));
  }

  function handleClose(index: number) {
    setShowModal(prev => {
      const newShowModal = [...prev];
      newShowModal[index] = false;
      return newShowModal;
    });
  }

  async function handleSplit(updatedImages: File[], insertIndex: number) {
    const currentFiles = images.map(x => x.file);
    const newFiles = [
      ...currentFiles.slice(0, insertIndex),
      ...updatedImages,
      ...currentFiles.slice(insertIndex + 1)
    ];
    await recreateImageArray(newFiles);
  }

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
            key={image.preview}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, index)}
            sx={{ cursor: 'move' }}
            secondaryAction={
              <>
                {needsSplit[index] && (
                  <IconButton
                    aria-label="split image"
                    onClick={() => {
                      setShowModal(prev => {
                        const newShowModal = [...prev];
                        newShowModal[index] = true;
                        return newShowModal;
                      });
                    }}
                  >
                    <ContentCutIcon />
                  </IconButton>
                )}
                {showModal[index] &&
                  createPortal(
                    <ImageSplitter 
                      file={image.file} 
                      index={index} 
                      returnImages={handleSplit} 
                      close={handleClose} 
                    />,
                    document.body,
                  )}
                <IconButton edge="end" aria-label="delete" onClick={() => removeImage(index)}>
                  <DeleteIcon />
                </IconButton>
              </>
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
        <Typography sx={{ mt: 1 }}>
          {images.length} image(s) uploaded. Drag and drop to reorder.
        </Typography>
      )}
    </Box>
  );
}