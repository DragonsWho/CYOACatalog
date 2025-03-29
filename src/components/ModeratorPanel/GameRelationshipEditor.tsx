// src/components/ModeratorPanel/GameRelationshipEditor.tsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Box, Typography, Autocomplete, TextField, Select, MenuItem, Button,
    IconButton, List, ListItem, ListItemText, CircularProgress, SelectChangeEvent,
    Link, Tooltip 
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { Link as RouterLink } from 'react-router-dom';
import {
    Game, GameRelationship, gameRelationshipsCollection,
    logFrontendError 
} from '../../pocketbase/pocketbase';

// Определяем типы связей, которые может установить модератор
const RELATIONSHIP_TYPES: GameRelationship['relationship_type'][] = [
    'Translation', 'Expansion', 'Sequel', 'Interactive Port', 'Static Port', 'DLC', 'Inspired By'
];

// Вспомогательная функция для форматирования отображения связи
const formatRelationship = (rel: GameRelationship, currentGameId: string): string => {
    const otherGame = rel.source_game === currentGameId ? rel.expand?.target_game : rel.expand?.source_game;
    const otherGameTitle = otherGame?.title || 'Unknown Game';

    if (rel.source_game === currentGameId) {
        // Текущая игра - источник
        switch(rel.relationship_type) {
            case 'Translation': return `is translated to "${otherGameTitle}" ${rel.target_language ? `(${rel.target_language})` : ''}`;
            case 'Expansion': return `has expansion "${otherGameTitle}"`;
            case 'Sequel': return `has sequel "${otherGameTitle}"`;
            case 'Interactive Port': return `has interactive port "${otherGameTitle}"`;
            case 'Static Port': return `has static port "${otherGameTitle}"`;
            case 'DLC': return `has DLC "${otherGameTitle}"`;
            case 'Inspired By': return `inspired "${otherGameTitle}"`;
            default: return `is related (${rel.relationship_type}) to "${otherGameTitle}"`;
        }
    } else {
        // Текущая игра - цель
         switch(rel.relationship_type) {
            case 'Translation': return `is a translation of "${otherGameTitle}" ${rel.source_language ? `(from ${rel.source_language})` : ''}`;
            case 'Expansion': return `is an expansion for "${otherGameTitle}"`;
            case 'Sequel': return `is a sequel to "${otherGameTitle}"`;
            case 'Interactive Port': return `is an interactive port of "${otherGameTitle}"`;
            case 'Static Port': return `is a static port of "${otherGameTitle}"`;
            case 'DLC': return `is a DLC for "${otherGameTitle}"`;
            case 'Inspired By': return `was inspired by "${otherGameTitle}"`;
            default: return `is related (${rel.relationship_type}) to "${otherGameTitle}"`;
        }
    }
};

interface GameRelationshipEditorProps {
    selectedGame: Game;
    allGames: Game[];
}

const GameRelationshipEditor: React.FC<GameRelationshipEditorProps> = ({ selectedGame, allGames }) => {
    const [relationships, setRelationships] = useState<GameRelationship[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Состояние для формы добавления
    const [targetGame, setTargetGame] = useState<Game | null>(null);
    const [relationshipType, setRelationshipType] = useState<GameRelationship['relationship_type'] | ''>('');
    const [sourceLanguage, setSourceLanguage] = useState('');
    const [targetLanguage, setTargetLanguage] = useState('');
    const [description, setDescription] = useState('');
    const [isAdding, setIsAdding] = useState(false);

    // Фильтруем список игр для Autocomplete, исключая текущую выбранную игру
    const availableTargetGames = useMemo(() => {
        return allGames.filter(game => game.id !== selectedGame.id);
    }, [allGames, selectedGame.id]);

    // Функция загрузки связей
    const fetchRelationships = useCallback(async () => {
        if (!selectedGame?.id) return;
        setIsLoading(true);
        setError(null);
        try {
            const filter = `(source_game = "${selectedGame.id}" || target_game = "${selectedGame.id}")`;
            const result = await gameRelationshipsCollection.getFullList({
                filter: filter,
                expand: 'source_game,target_game',
                sort: '-created'
            });
            setRelationships(result);
        } catch (err: any) {
            console.error("Error fetching relationships:", err);
            setError("Failed to load relationships.");
            logFrontendError("ModeratorPanel: Fetch relationships failed", { gameId: selectedGame.id, error: err });
        } finally {
            setIsLoading(false);
        }
    }, [selectedGame?.id]);

    // Загружаем связи при монтировании и при смене выбранной игры
    useEffect(() => {
        fetchRelationships();
    }, [fetchRelationships]);

    // Обработчик удаления связи
    const handleDelete = async (relationshipId: string) => {
        if (!window.confirm("Are you sure you want to delete this relationship?")) return;
        try {
            await gameRelationshipsCollection.delete(relationshipId);
            setRelationships(prev => prev.filter(rel => rel.id !== relationshipId));
        } catch (err: any) {
            console.error("Error deleting relationship:", err);
            alert("Failed to delete relationship.");
            logFrontendError("ModeratorPanel: Delete relationship failed", { relationshipId, error: err });
        }
    };

    // Обработчик добавления связи
    const handleAdd = async () => {
        if (!targetGame || !relationshipType) {
            alert("Please select a target game and relationship type.");
            return;
        }
        setIsAdding(true);
        try {
            const payload: Partial<GameRelationship> = {
                source_game: selectedGame.id,
                target_game: targetGame.id,
                relationship_type: relationshipType,
                description: description.trim() || undefined,
                source_language: relationshipType === 'Translation' ? sourceLanguage.trim() || undefined : undefined,
                target_language: relationshipType === 'Translation' ? targetLanguage.trim() || undefined : undefined,
            };

            await gameRelationshipsCollection.create(payload);

            setTargetGame(null);
            setRelationshipType('');
            setSourceLanguage('');
            setTargetLanguage('');
            setDescription('');
            await fetchRelationships();

        } catch (err: any) {
            console.error("Error adding relationship:", err);
            alert(`Failed to add relationship: ${err.message || 'Unknown error'}`);
            logFrontendError("ModeratorPanel: Add relationship failed", {
                sourceGameId: selectedGame.id,
                targetGameId: targetGame.id,
                type: relationshipType,
                error: err
            });
        } finally {
            setIsAdding(false);
        }
    };

    return (
        <Box sx={{ mt: 3, borderTop: '1px solid #555', pt: 2 }}>
            <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>
                Game Relationships
            </Typography>

            {/* Список существующих связей */}
            {isLoading && <CircularProgress size={24} />}
            {error && <Typography color="error">{error}</Typography>}
            {!isLoading && !error && relationships.length === 0 && (
                <Typography variant="body2" sx={{ color: '#aaa' }}>No relationships found.</Typography>
            )}
            {!isLoading && !error && relationships.length > 0 && (
                <List dense sx={{ mb: 2 }}>
                    {relationships.map((rel) => {
                        const otherGame = rel.source_game === selectedGame.id ? rel.expand?.target_game : rel.expand?.source_game;
                        return (
                            <ListItem
                                key={rel.id}
                                disableGutters
                                secondaryAction={
                                    <Tooltip title="Delete Relationship">
                                        <IconButton edge="end" aria-label="delete" onClick={() => handleDelete(rel.id)} size="small">
                                            <DeleteIcon sx={{ color: '#aaa', '&:hover': { color: 'red'} }}/>
                                        </IconButton>
                                     </Tooltip>
                                }
                            >
                                <ListItemText
                                    primary={
                                        <Typography variant="body2" component="span">
                                            This game {formatRelationship(rel, selectedGame.id)}
                                             {rel.description && <Typography variant="caption" sx={{ ml: 1, color: '#bbb' }}>({rel.description})</Typography>}
                                        </Typography>
                                    }
                                    secondary={otherGame &&
                                        <Link component={RouterLink} to={`/game/${otherGame.id}`} target="_blank" rel="noopener noreferrer" sx={{ fontSize: '0.75rem'}}>
                                            View related game
                                        </Link>
                                    }
                                />
                            </ListItem>
                        );
                    })}
                </List>
            )}

            {/* Форма добавления новой связи */}
            <Typography variant="subtitle2" sx={{ color: '#ccc', mt: 2, mb: 1 }}>
            Add New Relationship (This Game → Other Game)
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                 {/* Выбор целевой игры */}
                 <Autocomplete
                     options={availableTargetGames}
                     getOptionLabel={(option) => `${option.title || 'Untitled'} (ID: ${option.id})`} // Добавим ID для ясности
                     value={targetGame}
                     onChange={(_, newValue) => setTargetGame(newValue)}
                     renderInput={(params) => (
                         <TextField
                             {...params}
                             label="Relate this game to..."
                             variant="outlined"
                             size="small"
                         />
                     )}
                     sx={{
                         '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' }, '&:hover fieldset': { borderColor: '#ccc' }, '&.Mui-focused fieldset': { borderColor: 'primary.main' }, },
                         '& .MuiInputLabel-root': { color: '#aaa' },
                         '& .MuiAutocomplete-input': { color: '#e0e0e0' },
                         '& .MuiAutocomplete-popupIndicator': { color: '#aaa'},
                         '& .MuiAutocomplete-clearIndicator': { color: '#aaa'}
                     }}
                      // <<<=== ИСПРАВЛЕНО: Используем slotProps для стилизации выпадающего списка ===>>>
                      slotProps={{
                          paper: {
                              sx: { bgcolor: '#333', color: '#e0e0e0' }
                          }
                      }}
                      // <<<=== КОНЕЦ ИСПРАВЛЕНИЯ ===>>>
                 />

                {/* Выбор типа связи */}
                <Select
                    value={relationshipType}
                    onChange={(event: SelectChangeEvent) => setRelationshipType(event.target.value as GameRelationship['relationship_type'] | '')}
                    displayEmpty
                    fullWidth
                    size="small"
                    sx={{
                         color: relationshipType ? '#e0e0e0' : '#aaa',
                        '& .MuiOutlinedInput-notchedOutline': { borderColor: '#aaa' },
                        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#ccc' },
                        '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'primary.main' },
                         '& .MuiSelect-icon': { color: '#aaa' }
                     }}
                    MenuProps={{ PaperProps: { sx: { backgroundColor: '#333', color: '#e0e0e0' } } }}
                >
                    <MenuItem value="" disabled><em>Select Relationship Type</em></MenuItem>
                    {RELATIONSHIP_TYPES.map((type) => (
                        <MenuItem key={type} value={type}>{type}</MenuItem>
                    ))}
                </Select>

                {/* Поля для языков */}
                {relationshipType === 'Translation' && (
                    <Box sx={{ display: 'flex', gap: 1 }}>
                        <TextField label="Source Language (e.g., EN)" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} variant="outlined" size="small" fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/>
                        <TextField label="Target Language (e.g., RU)" value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)} variant="outlined" size="small" fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/>
                    </Box>
                )}

                {/* Поле для описания */}
                <TextField label="Description (Optional)" value={description} onChange={(e) => setDescription(e.target.value)} variant="outlined" size="small" fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/>

                {/* Кнопка добавления */}
                <Button variant="contained" color="secondary" onClick={handleAdd} disabled={!targetGame || !relationshipType || isAdding} startIcon={isAdding ? <CircularProgress size={20} color="inherit" /> : null}>
                    Add Relationship
                </Button>
            </Box>
        </Box>
    );
};

export default GameRelationshipEditor;