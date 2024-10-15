// src/components/Add/CyoaImageUploader.tsx
// Version 1.4.0
// Changes: Removed immediate image processing, added function to get images for upload

import React, { useEffect, useState } from 'react';
import { Box, Button, Typography, List, ListItem, ListItemText, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
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
    onNeedsSplitChange(needsSplit.some(x => x === true))
  }, [needsSplit])

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    newImages.map(async (image, idx) => {
      const update: boolean = await getNeedsSplit(image.file);
      setNeedsSplit((needsSplit) => {
        needsSplit[idx] = update;
        return [...needsSplit];
      });
    });

    setImages((prevImages) => [...prevImages, ...newImages]);
    onImagesChange(
      [...images, ...newImages].map((img, index) => {
        showModal[index] = false;
        setShowModal([...showModal]);
        return img.file;
      }),
    );
  }


  // utility function to handle everything that needs to be done
  // after changing file array
  // basically the same as the above function, except it takes the already
  // updated file array as input
  function recreateImageArray(files: File[]) {
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));

    newImages.map(async (image, idx) => {
      const update: boolean = await getNeedsSplit(image.file);
      setNeedsSplit((needsSplit) => {
        needsSplit[idx] = update;
        return [...needsSplit];
      });
    });

    setImages([...newImages]);
    onImagesChange(
      [...newImages].map((img, index) => {
        showModal[index] = false;
        setShowModal([...showModal]);
        return img.file;
      }),
    );
  }

  function handleDragStart(e: React.DragEvent<HTMLLIElement>, index: number) {
    e.dataTransfer.setData('text/plain', index.toString());
  }

  function handleDragOver(e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent<HTMLLIElement>, dropIndex: number) {
    e.preventDefault();
    const dragIndex = Number(e.dataTransfer.getData('text/plain'));
    const newImages = [...images];
    const [reorderedItem] = newImages.splice(dragIndex, 1);
    newImages.splice(dropIndex, 0, reorderedItem);
    setImages(newImages);
    onImagesChange(newImages.map((img) => img.file));
  }

  function removeImage(index: number) {
    const newImages = images.filter((_, i) => i !== index);
    setImages(newImages);
    onImagesChange(newImages.map((img) => img.file));
  }

  // modal
  function handleClose(index: number) {
    showModal[index] = false;
    setShowModal([...showModal]);
  }


  // of we split a image, this inserts the new images
  // updatedImages: the 2 images that the image was split into
  // insertIndex: the array index of the image that was split
  function handleSplit(updatedImages: File[], insertIndex: number) {
    let files: File[] = images.map((x: { file: File; preview: string }) => x.file);
    files.splice(insertIndex, 1, ...updatedImages);
    recreateImageArray(files);
  }


  // determines if the image needs to be split
  // loads the image as a bitmap object
  // couldn't find a better way to do it than this
  async function getNeedsSplit(file: File): Promise<boolean> {
    let image;
    try {
      image = await createImageBitmap(file);
    } catch (e) {
      return false;
    }
    return image.height > 16383;
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
            key={index}
            draggable
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, index)}
            sx={{ cursor: 'move' }}
            secondaryAction={
              <>
                {needsSplit[index] && (
                  <HorizontalSplitIcon
                    onClick={() => {
                      showModal[index] = true;
                      setShowModal([...showModal]);
                    }}
                  />
                )}
                {showModal[index] &&
                  createPortal(
                    <ImageSplitter file={image.file} index={index} returnImages={handleSplit} close={handleClose} />,
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
        <Typography sx={{ mt: 1 }}>{images.length} image(s) uploaded. Drag and drop to reorder.</Typography>
      )}
    </Box>
  );
}
