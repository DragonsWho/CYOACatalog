// src/components/Add/AuthorSelector.tsx
// Version 2.1.0
// Converted to TypeScript and fixed type issues

import { useState, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { TextField, Chip, Typography, Box, Button } from '@mui/material';
import { debounce } from 'lodash';
import { Author, authorsCollection } from '../../pocketbase/pocketbase';

// Configurable maximum Levenshtein distance
const MAX_LEVENSHTEIN_DISTANCE = 3;

interface AuthorWithDistance extends Author {
  distance: number;
}

interface AuthorSelectorProps {
  value: Author[];
  onChange: (authors: Author[]) => void;
  availableAuthors: Author[];
  onAuthorsChange: (authors: Author[]) => void;
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

function findSimilarAuthors(input: string, availableAuthors: Author[], maxResults: number = 3): AuthorWithDistance[] {
  const normalizedInput = input.toLowerCase().trim();

  const authorDistances = availableAuthors.map((author) => ({
    ...author,
    distance: levenshteinDistance(normalizedInput, author.name.toLowerCase()),
  }));

  const filteredAuthors = authorDistances.filter((author) => author.distance <= MAX_LEVENSHTEIN_DISTANCE);

  filteredAuthors.sort((a, b) => a.distance - b.distance);

  return filteredAuthors.slice(0, maxResults);
}

async function createNewAuthor(authorName: string): Promise<Author> {
  return await authorsCollection.create({ name: authorName });
}

export default function AuthorSelector({ value, onChange, availableAuthors, onAuthorsChange }: AuthorSelectorProps) {
  const [inputValue, setInputValue] = useState<string>('');
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<Author[]>([]);
  const [similarAuthors, setSimilarAuthors] = useState<AuthorWithDistance[]>([]);
  const [isCreatingAuthor, setIsCreatingAuthor] = useState<boolean>(false);

  useEffect(() => {
    setInputValue('');
    setAutocompleteSuggestions([]);
    setSimilarAuthors([]);
  }, [value]);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const newValue = event.target.value;
    setInputValue(newValue);
    debouncedFindSuggestions(newValue);
  }

  async function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && inputValue.trim() !== '') await handleCreateOrSelectAuthor();
  }

  async function handleCreateOrSelectAuthor() {
    const trimmedValue = inputValue.trim();
    const existingAuthor = availableAuthors.find((author) => author.name.toLowerCase() === trimmedValue.toLowerCase());

    if (existingAuthor) {
      if (!value.some((v) => v.id === existingAuthor.id)) onChange([...value, existingAuthor]);
    } else {
      await handleCreateNewAuthor();
    }

    setInputValue('');
    setAutocompleteSuggestions([]);
    setSimilarAuthors([]);
  }

  async function handleCreateNewAuthor() {
    setIsCreatingAuthor(true);
    const newAuthor = await createNewAuthor(inputValue.trim());
    onChange([...value, newAuthor]);
    onAuthorsChange([...availableAuthors, newAuthor]);
    setIsCreatingAuthor(false);
    setInputValue('');
  }

  function handleAuthorDelete(authorToDelete: Author) {
    onChange(value.filter((author) => author.id !== authorToDelete.id));
  }

  function handleSuggestionClick(suggestion: Author) {
    if (!value.some((v) => v.id === suggestion.id)) onChange([...value, suggestion]);
    setInputValue('');
    setAutocompleteSuggestions([]);
    setSimilarAuthors([]);
  }

  const debouncedFindSuggestions = debounce((input: string) => {
    if (input) {
      const autoSuggestions = availableAuthors
        .filter((author) => author.name.toLowerCase().includes(input.toLowerCase()))
        .slice(0, 5);
      setAutocompleteSuggestions(autoSuggestions);

      if (!availableAuthors.some((author) => author.name.toLowerCase() === input.toLowerCase())) {
        const similar = findSimilarAuthors(input, availableAuthors);
        const filteredSimilar = similar.filter(
          (author) => !value.some((v) => v.id === author.id) && !autoSuggestions.some((a) => a.id === author.id),
        );

        const bestAutocompleteDist =
          autoSuggestions.length > 0
            ? levenshteinDistance(input.toLowerCase(), autoSuggestions[0].name.toLowerCase())
            : Infinity;
        const bestSimilarDist = filteredSimilar.length > 0 ? filteredSimilar[0].distance : Infinity;

        if (bestSimilarDist < bestAutocompleteDist && bestSimilarDist <= MAX_LEVENSHTEIN_DISTANCE) {
          setSimilarAuthors(filteredSimilar.slice(0, 5));
        } else {
          setSimilarAuthors([]);
        }
      } else {
        setSimilarAuthors([]);
      }
    } else {
      setAutocompleteSuggestions([]);
      setSimilarAuthors([]);
    }
  }, 300);

  const isNewAuthor =
    inputValue.trim() !== '' &&
    !availableAuthors.some((author) => author.name.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <Box>
      <Box mb={2}>
        {value.map((author) => (
          <Chip
            key={author.id}
            label={author.name}
            onDelete={() => handleAuthorDelete(author)}
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
        placeholder="Add authors..."
      />
      {isNewAuthor && (
        <Box mt={1}>
          <Button variant="contained" color="primary" onClick={handleCreateOrSelectAuthor} disabled={isCreatingAuthor}>
            Create New Author: {inputValue}
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
      {similarAuthors.length > 0 && (
        <Box mt={1}>
          <Typography variant="subtitle2">Did you mean:</Typography>
          {similarAuthors.map((suggestion) => (
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
