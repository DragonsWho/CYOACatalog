// src/components/Add/GameBasicInfo.tsx
// Version 1.0
// New component: Basic game information input fields

import React from 'react';
import { TextField } from '@mui/material';

interface GameBasicInfoProps {
    title: string;
    setTitle: (title: string) => void;
    description: string;
    setDescription: (description: string) => void;
}

function GameBasicInfo({ title, setTitle, description, setDescription }: GameBasicInfoProps): JSX.Element {
    return (
        <>
            <TextField
                fullWidth
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                margin="normal"
                required
            />
            <TextField
                fullWidth
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                margin="normal"
                required
                multiline
                rows={4}
            />
        </>
    );
}

export default GameBasicInfo;