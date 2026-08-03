import React, { useEffect, useState } from 'react';
import { Box, Button, Typography, List, ListItem, ListItemText, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ImageSplitter from './ImageSplitter/ImageSpliter';
import { createPortal } from 'react-dom';

interface CyoaImage {
  file: File;
  preview: string;
}

interface CyoaImageUploaderProps {
  onImagesChange: (files: File[]) => void;
  onNeedsSplitChange: (needsSplit: boolean) => void;
}

export default function CyoaImageUploader({
  onImagesChange,
  onNeedsSplitChange,
}: CyoaImageUploaderProps) {
  const [images, setImages] = useState<CyoaImage[]>([]);
  const [showModal, setShowModal] = useState<boolean[]>([]);
  const [needsSplit, setNeedsSplit] = useState<boolean[]>([]);

  useEffect(() => {
    onNeedsSplitChange(needsSplit.some(x => x === true));
  }, [needsSplit, onNeedsSplitChange]);

  async function getNeedsSplit(file: File): Promise<boolean> {
    try {
      const image = await createImageBitmap(file);
      return image.height > 16383;
    } catch (e) {
      return false;
    }
  }

  async function updateNeedsSplitStates(files: File[]): Promise<void> {
    const splitStates = await Promise.all(files.map(file => getNeedsSplit(file)));
    setNeedsSplit(splitStates);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files || []);
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    const updatedImages = [...images, ...newImages];
    setImages(updatedImages);
    setShowModal(new Array(updatedImages.length).fill(false));
    await updateNeedsSplitStates(updatedImages.map(img => img.file));
    onImagesChange(updatedImages.map(img => img.file));
  }

  async function recreateImageArray(files: File[]): Promise<void> {
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    setImages(newImages);
    setShowModal(new Array(newImages.length).fill(false));
    await updateNeedsSplitStates(files);
    onImagesChange(newImages.map(img => img.file));
  }

  async function handleDrop(e: React.DragEvent<HTMLLIElement>, dropIndex: number): Promise<void> {
    e.preventDefault();
    const dragIndex = Number(e.dataTransfer.getData('text/plain'));
    
    const newImages = [...images];
    const [reorderedItem] = newImages.splice(dragIndex, 1);
    newImages.splice(dropIndex, 0, reorderedItem);
    
    setImages(newImages);
    
    const newNeedsSplit = [...needsSplit];
    const [reorderedSplit] = newNeedsSplit.splice(dragIndex, 1);
    newNeedsSplit.splice(dropIndex, 0, reorderedSplit);
    setNeedsSplit(newNeedsSplit);
    
    onImagesChange(newImages.map(img => img.file));
  }

  function handleDragStart(e: React.DragEvent<HTMLLIElement>, index: number): void {
    e.dataTransfer.setData('text/plain', index.toString());
  }

  function handleDragOver(e: React.DragEvent<HTMLLIElement>): void {
    e.preventDefault();
  }

  function removeImage(index: number): void {
    const newImages = images.filter((_, i) => i !== index);
    const newNeedsSplit = needsSplit.filter((_, i) => i !== index);
    const newShowModal = showModal.filter((_, i) => i !== index);
    
    setImages(newImages);
    setNeedsSplit(newNeedsSplit);
    setShowModal(newShowModal);
    
    onImagesChange(newImages.map(img => img.file));
  }

  function handleClose(index: number): void {
    setShowModal(prev => {
      const newShowModal = [...prev];
      newShowModal[index] = false;
      return newShowModal;
    });
  }

  async function handleSplit(updatedImages: File[], insertIndex: number): Promise<void> {
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
            sx={{ 
              cursor: 'move',
              '&:hover': {
                backgroundColor: 'rgba(0, 0, 0, 0.04)',
              },
              padding: 2,
            }}
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
                <IconButton edge="end" aria-label="delete" onClick={() => removeImage(index)}>
                  <DeleteIcon />
                </IconButton>
              </>
            }
          >
            <DragIndicatorIcon sx={{ mr: 2 }} />
            <Box
              sx={{
                width: 180,
                height: 100,
                marginRight: 2,
                overflow: 'hidden',
                position: 'relative',
                borderRadius: 1,
                border: '1px solid rgba(0, 0, 0, 0.12)',
              }}
            >
              <img
                src={image.preview}
                alt={`CYOA page ${index + 1}`}
                style={{
                  width: '100%',
                  height: 'auto',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                }}
              />
            </Box>
            <ListItemText 
              primary={`Page ${index + 1}`} 
              secondary={image.file.name}
              sx={{ flex: 1, minWidth: 0 }} 
            />
          </ListItem>
        ))}
      </List>
      {images.length > 0 && (
        <Typography sx={{ mt: 1 }}>
          {images.length} image(s) uploaded. Drag and drop to reorder.
        </Typography>
      )}
      {showModal.map((show, index) => 
        show && createPortal(
          <ImageSplitter 
            file={images[index].file} 
            index={index} 
            returnImages={handleSplit} 
            close={() => handleClose(index)} 
          />,
          document.body,
        )
      )}
    </Box>
  );
}