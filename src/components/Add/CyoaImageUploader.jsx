// src/components/Add/CyoaImageUploader.jsx
// Version 1.1.0

import React, { useState, useCallback } from 'react'
import {
    Box,
    Button,
    Typography,
    List,
    ListItem,
    ListItemText,
    ListItemSecondaryAction,
    IconButton,
} from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'

const CyoaImageUploader = ({ onImagesChange }) => {
    const [images, setImages] = useState([])

    const processImage = useCallback(async (file) => {
        //
        if (file.size <= 10 * 1024 * 1024) {
            return file
        }

        return new Promise((resolve, reject) => {
            const img = new Image()
            img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = img.width
                canvas.height = img.height

                const ctx = canvas.getContext('2d')
                ctx.drawImage(img, 0, 0)

                const process = (quality) => {
                    canvas.toBlob(
                        (blob) => {
                            if (blob) {
                                if (blob.size <= 10 * 1024 * 1024 || quality <= 0.7) {
                                    const processedFile = new File([blob], file.name, {
                                        type: file.type,
                                        lastModified: Date.now(),
                                    })
                                    resolve(processedFile)
                                } else {
                                    process(quality - 0.05)
                                }
                            } else {
                                reject(new Error('Canvas to Blob conversion failed'))
                            }
                        },
                        file.type,
                        quality,
                    )
                }

                process(1) //
            }
            img.onerror = (error) => reject(error)
            img.src = URL.createObjectURL(file)
        })
    }, [])

    const handleFileChange = async (event) => {
        const files = Array.from(event.target.files)
        const processedImages = await Promise.all(
            files.map(async (file) => {
                console.log(`Original file size: ${file.size} bytes`)
                const processedFile = await processImage(file)
                console.log(`Processed file size: ${processedFile.size} bytes`)
                return {
                    file: processedFile,
                    preview: URL.createObjectURL(processedFile),
                }
            }),
        )
        setImages((prevImages) => [...prevImages, ...processedImages])
        onImagesChange([...images, ...processedImages].map((img) => img.file))
    }

    const handleDragStart = (e, index) => {
        e.dataTransfer.setData('text/plain', index)
    }

    const handleDragOver = (e) => {
        e.preventDefault()
    }

    const handleDrop = useCallback(
        (e, dropIndex) => {
            e.preventDefault()
            const dragIndex = Number(e.dataTransfer.getData('text/plain'))
            const newImages = [...images]
            const [reorderedItem] = newImages.splice(dragIndex, 1)
            newImages.splice(dropIndex, 0, reorderedItem)
            setImages(newImages)
            onImagesChange(newImages.map((img) => img.file))
        },
        [images, onImagesChange],
    )

    const removeImage = useCallback(
        (index) => {
            const newImages = images.filter((_, i) => i !== index)
            setImages(newImages)
            onImagesChange(newImages.map((img) => img.file))
        },
        [images, onImagesChange],
    )

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
                        <img
                            src={image.preview}
                            alt={`CYOA page ${index + 1}`}
                            style={{ width: 50, height: 50, marginRight: 10 }}
                        />
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
                <Typography sx={{ mt: 1 }}>{images.length} image(s) uploaded. Drag and drop to reorder.</Typography>
            )}
        </Box>
    )
}

export default CyoaImageUploader
