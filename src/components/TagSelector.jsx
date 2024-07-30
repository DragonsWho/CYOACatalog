// src/components/TagSelector.jsx
// Version 1.1.0

import React from 'react';
import { Autocomplete, TextField, Chip } from '@mui/material';

function TagSelector({ value, onChange, availableTags }) {
    return (
        <Autocomplete
            multiple
            id="tags-outlined"
            options={availableTags}
            getOptionLabel={(option) => option.name}
            value={value}
            onChange={(event, newValue) => {
                onChange(newValue);
            }}
            renderInput={(params) => (
                <TextField
                    {...params}
                    variant="outlined"
                    label="Tags"
                    placeholder="Select tags"
                />
            )}
            renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                    <Chip
                        variant="outlined"
                        label={option.name}
                        {...getTagProps({ index })}
                    />
                ))
            }
        />
    );
}

export default TagSelector;