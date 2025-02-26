// src/components/Add/CustomTagSelector.tsx
import { useState, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { TextField, Chip, Typography, Box, Button } from '@mui/material';
import { tagsCollection } from '../../pocketbase/pocketbase';

// Configurable maximum Levenshtein distance
const MAX_LEVENSHTEIN_DISTANCE = 3;

// Tag interface based on your existing schema
interface Tag {
  id: string;
  name: string;
  description?: string;
}

interface TagWithDistance extends Tag {
  distance: number;
}

interface CustomTagSelectorProps {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
  availableTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
  categoryId?: string; // Optional category ID for new tags
}

function levenshteinDistance(a: string, b: string, maxDistance: number = MAX_LEVENSHTEIN_DISTANCE): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    let minDistanceInRow = Infinity;
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
      minDistanceInRow = Math.min(minDistanceInRow, matrix[i][j]);
    }
    if (minDistanceInRow > maxDistance) {
      return Infinity;
    }
  }

  return matrix[b.length][a.length];
}

function findSimilarTags(input: string, availableTags: Tag[], maxResults: number = 3): TagWithDistance[] {
  const normalizedInput = input.toLowerCase().trim();

  const tagDistances = availableTags.map((tag) => ({
    ...tag,
    distance: levenshteinDistance(normalizedInput, tag.name.toLowerCase()),
  }));

  const filteredTags = tagDistances.filter((tag) => tag.distance <= MAX_LEVENSHTEIN_DISTANCE);

  filteredTags.sort((a, b) => a.distance - b.distance);

  return filteredTags.slice(0, maxResults);
}

async function createNewTag(tagName: string, categoryId?: string): Promise<Tag> {
  const tagData: {name: string, description?: string} = { name: tagName };
  
  return await tagsCollection.create(tagData);
}

export default function CustomTagSelector({ value, onChange, availableTags, onTagsChange, categoryId }: CustomTagSelectorProps) {
  const [inputValue, setInputValue] = useState<string>('');
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<Tag[]>([]);
  const [similarTags, setSimilarTags] = useState<TagWithDistance[]>([]);
  const [isCreatingTag, setIsCreatingTag] = useState<boolean>(false);

  useEffect(() => {
    setInputValue('');
    setAutocompleteSuggestions([]);
    setSimilarTags([]);
  }, [value]);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const newValue = event.target.value;
    setInputValue(newValue);
    debouncedFindSuggestions(newValue);
  }

  async function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && inputValue.trim() !== '') await handleCreateOrSelectTag();
  }

  async function handleCreateOrSelectTag() {
    const trimmedValue = inputValue.trim();
    const existingTag = availableTags.find((tag) => tag.name.toLowerCase() === trimmedValue.toLowerCase());

    if (existingTag) {
      if (!value.some((v) => v.id === existingTag.id)) onChange([...value, existingTag]);
    } else {
      await handleCreateNewTag();
    }

    setInputValue('');
    setAutocompleteSuggestions([]);
    setSimilarTags([]);
  }

  async function handleCreateNewTag() {
    setIsCreatingTag(true);
    const newTag = await createNewTag(inputValue.trim(), categoryId);
    onChange([...value, newTag]);
    onTagsChange([...availableTags, newTag]);
    setIsCreatingTag(false);
    setInputValue('');
  }

  function handleTagDelete(tagToDelete: Tag) {
    onChange(value.filter((tag) => tag.id !== tagToDelete.id));
  }

  function handleSuggestionClick(suggestion: Tag) {
    if (!value.some((v) => v.id === suggestion.id)) onChange([...value, suggestion]);
    setInputValue('');
    setAutocompleteSuggestions([]);
    setSimilarTags([]);
  }

  function debounce<A extends unknown[]>(callback: (...args: A) => void, wait: number) {
    let timeoutId: number | undefined = undefined;
    return (...args: A) => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => callback(...args), wait);
    };
  }

  const debouncedFindSuggestions = debounce((input: string) => {
    if (input) {
      const autoSuggestions = availableTags
        .filter((tag) => tag.name.toLowerCase().includes(input.toLowerCase()))
        .slice(0, 5);
      setAutocompleteSuggestions(autoSuggestions);

      if (!availableTags.some((tag) => tag.name.toLowerCase() === input.toLowerCase())) {
        const similar = findSimilarTags(input, availableTags);
        const filteredSimilar = similar.filter(
          (tag) => !value.some((v) => v.id === tag.id) && !autoSuggestions.some((a) => a.id === tag.id),
        );

        const bestAutocompleteDist =
          autoSuggestions.length > 0
            ? levenshteinDistance(input.toLowerCase(), autoSuggestions[0].name.toLowerCase())
            : Infinity;
        const bestSimilarDist = filteredSimilar.length > 0 ? filteredSimilar[0].distance : Infinity;

        if (bestSimilarDist < bestAutocompleteDist && bestSimilarDist <= MAX_LEVENSHTEIN_DISTANCE) {
          setSimilarTags(filteredSimilar.slice(0, 5));
        } else {
          setSimilarTags([]);
        }
      } else {
        setSimilarTags([]);
      }
    } else {
      setAutocompleteSuggestions([]);
      setSimilarTags([]);
    }
  }, 300);

  const isNewTag =
    inputValue.trim() !== '' &&
    !availableTags.some((tag) => tag.name.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <Box>
      <Box mb={2}>
        {value.map((tag) => (
          <Chip
            key={tag.id}
            label={tag.name}
            onDelete={() => handleTagDelete(tag)}
            style={{ margin: '0 5px 5px 0' }}
          />
        ))}
      </Box>
      <TextField
        fullWidth
        variant="outlined"
        value={inputValue}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Add custom tags..."
      />
      {isNewTag && (
        <Box mt={1}>
          <Button variant="contained" color="primary" onClick={handleCreateOrSelectTag} disabled={isCreatingTag}>
            Create New Tag: {inputValue}
          </Button>
        </Box>
      )}
      {autocompleteSuggestions.length > 0 && (
        <Box mt={1}>
          <Typography variant="subtitle2">Suggestions:</Typography>
          {autocompleteSuggestions.map((suggestion) => (
            <Chip
              key={suggestion.id}
              label={suggestion.name}
              onClick={() => handleSuggestionClick(suggestion)}
              style={{ margin: '0 5px 5px 0', cursor: 'pointer' }}
            />
          ))}
        </Box>
      )}
      {similarTags.length > 0 && (
        <Box mt={1}>
          <Typography variant="subtitle2">Did you mean:</Typography>
          {similarTags.map((suggestion) => (
            <Chip
              key={suggestion.id}
              label={suggestion.name}
              onClick={() => handleSuggestionClick(suggestion)}
              style={{ margin: '0 5px 5px 0', cursor: 'pointer' }}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}