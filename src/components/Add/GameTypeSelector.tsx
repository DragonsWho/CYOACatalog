// src/components/Add/GameTypeSelector.tsx
// Version 1.0
// New component: Game type selection (image or link)

import React from 'react';
import { FormControl, InputLabel, Select, MenuItem, TextField, SelectChangeEvent } from '@mui/material';

interface GameTypeSelectorProps {
    imgOrLink: 'img' | 'link';
    setImgOrLink: (type: 'img' | 'link') => void;
    iframeUrl: string;
    setIframeUrl: (url: string) => void;
}

function GameTypeSelector({ imgOrLink, setImgOrLink, iframeUrl, setIframeUrl }: GameTypeSelectorProps): JSX.Element {
    return (
        <>
            <FormControl fullWidth margin="normal">
                <InputLabel id="img-or-link-label">Image or Link</InputLabel>
                <Select
                    labelId="img-or-link-label"
                    value={imgOrLink}
                    onChange={(e: SelectChangeEvent<'img' | 'link'>) => setImgOrLink(e.target.value as 'img' | 'link')}
                    label="Image or Link"
                >
                    <MenuItem value="img">Image</MenuItem>
                    <MenuItem value="link">Link</MenuItem>
                </Select>
            </FormControl>
            {imgOrLink === 'link' && (
                <TextField
                    fullWidth
                    label="iframe URL"
                    value={iframeUrl}
                    onChange={(e) => setIframeUrl(e.target.value)}
                    margin="normal"
                    required
                />
            )}
        </>
    );
}

export default GameTypeSelector;