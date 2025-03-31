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
    Game, GameRelationship, gameRelationshipsCollection
} from '../../pocketbase/pocketbase';

interface RelationshipOption {
    value: string;
    label: string;
    dbType: GameRelationship['relationship_type'];
    swapSourceTarget: boolean;
}

const RELATIONSHIP_OPTIONS: RelationshipOption[] = [
    { value: 't_t_o', label: 'Translation (this -> other)', dbType: 'Translation', swapSourceTarget: false },
    { value: 't_o_t', label: 'Translation (other -> this)', dbType: 'Translation', swapSourceTarget: true },
    { value: 'e_t_o', label: 'Expansion/DLC (this -> other)', dbType: 'Expansion', swapSourceTarget: false },
    { value: 'e_o_t', label: 'Expansion/DLC (other -> this)', dbType: 'Expansion', swapSourceTarget: true },
    { value: 's_t_o', label: 'Sequel (this -> other)', dbType: 'Sequel', swapSourceTarget: false },
    { value: 's_o_t', label: 'Sequel (other -> this)', dbType: 'Sequel', swapSourceTarget: true },
    { value: 'ip_t_o', label: 'Interactive Port (this -> other)', dbType: 'Interactive Port', swapSourceTarget: false },
    { value: 'ip_o_t', label: 'Interactive Port (other -> this)', dbType: 'Interactive Port', swapSourceTarget: true },
    { value: 'sp_t_o', label: 'Static Port (this -> other)', dbType: 'Static Port', swapSourceTarget: false },
    { value: 'sp_o_t', label: 'Static Port (other -> this)', dbType: 'Static Port', swapSourceTarget: true },
    { value: 'i_t_o', label: 'Inspired By (this -> other)', dbType: 'Inspired By', swapSourceTarget: false },
    { value: 'i_o_t', label: 'Inspired By (other -> this)', dbType: 'Inspired By', swapSourceTarget: true },
];


const formatRelationshipForModerator = (rel: GameRelationship, currentGameId: string): React.ReactNode => {
    const otherGame = rel.source_game === currentGameId ? rel.expand?.target_game : rel.expand?.source_game;
    const otherGameTitle = otherGame?.title || 'Unknown Game';
    let baseText = '';
    let langInfo = '';

    if (rel.source_game === currentGameId) {
        baseText = `relates (${rel.relationship_type}) to "${otherGameTitle}"`;
        if (rel.relationship_type === 'Translation' && rel.target_language) langInfo = `(${rel.source_language || '?'} -> ${rel.target_language})`;
    } else {
         baseText = `is related (${rel.relationship_type}) from "${otherGameTitle}"`;
         if (rel.relationship_type === 'Translation' && rel.source_language) langInfo = `(${rel.source_language} -> ${rel.target_language || '?'})`;
    }

    return (
        <>
            {baseText} {langInfo && <Typography variant="caption" sx={{ color: '#aaa', ml: 0.5 }}>{langInfo}</Typography>}
            {(rel.description_source || rel.description_target) && (
                 <Typography variant="caption" display="block" sx={{ color: '#bbb', mt: 0.2, ml:1 }}>
                    {rel.description_source && <span>Src Desc: "{rel.description_source}" </span>}
                    {rel.description_target && <span>Tgt Desc: "{rel.description_target}"</span>}
                </Typography>
             )}
        </>
    );
};


interface GameRelationshipEditorProps {
    selectedGame: Game;
    allGames: Game[];
}

const GameRelationshipEditor: React.FC<GameRelationshipEditorProps> = ({ selectedGame, allGames }) => {
    const [relationships, setRelationships] = useState<GameRelationship[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);


    const [targetGame, setTargetGame] = useState<Game | null>(null);
    const [selectedOptionValue, setSelectedOptionValue] = useState<string>('');
    const [language1, setLanguage1] = useState('');
    const [language2, setLanguage2] = useState('');
    const [descriptionThis, setDescriptionThis] = useState('');
    const [descriptionOther, setDescriptionOther] = useState('');
    const [isAdding, setIsAdding] = useState(false);

    const availableTargetGames = useMemo(() => {
        return allGames.filter(game => game.id !== selectedGame.id);
    }, [allGames, selectedGame.id]);

    const selectedOption = useMemo(() => {
        return RELATIONSHIP_OPTIONS.find(opt => opt.value === selectedOptionValue);
    }, [selectedOptionValue]);

    const fetchRelationships = useCallback(async () => {
        if (!selectedGame?.id) return;
        setIsLoading(true); setError(null);
        try {
            const filter = `(source_game = "${selectedGame.id}" || target_game = "${selectedGame.id}")`;
            const result = await gameRelationshipsCollection.getFullList({ filter: filter, expand: 'source_game,target_game', sort: '-created' });
            setRelationships(result);
        }
        catch (err: any) {
            console.error("ModeratorPanel: Fetch relationships failed", { gameId: selectedGame.id, error: err }); // Заменено на console.error
            setError("Failed to load relationships.");
        }
        finally { setIsLoading(false); }
    }, [selectedGame?.id]);

    useEffect(() => { fetchRelationships(); }, [fetchRelationships]);

    const handleDelete = async (relationshipId: string) => {
        if (!window.confirm("Are you sure you want to delete this relationship?")) return;
        try {
            await gameRelationshipsCollection.delete(relationshipId);
            setRelationships(prev => prev.filter(rel => rel.id !== relationshipId));
        }
        catch (err: any) {
            console.error("ModeratorPanel: Delete relationship failed", { relationshipId, error: err }); // Заменено на console.error
            alert("Failed to delete relationship.");
        }
    };

    const handleAdd = async () => {
        if (!targetGame || !selectedOption) { alert("Please select a target game and relationship type."); return; }
        setIsAdding(true);
        try {
            const sourceId = selectedOption.swapSourceTarget ? targetGame.id : selectedGame.id;
            const targetId = selectedOption.swapSourceTarget ? selectedGame.id : targetGame.id;
            const dbType = selectedOption.dbType;
            const descSource = selectedOption.swapSourceTarget ? descriptionOther.trim() || undefined : descriptionThis.trim() || undefined;
            const descTarget = selectedOption.swapSourceTarget ? descriptionThis.trim() || undefined : descriptionOther.trim() || undefined;
            let langSource: string | undefined = undefined;
            let langTarget: string | undefined = undefined;
            if (dbType === 'Translation') {
                langSource = language1.trim() || undefined;
                langTarget = language2.trim() || undefined;
            }

            const payload: Partial<GameRelationship> = {
                source_game: sourceId, target_game: targetId, relationship_type: dbType,
                description_source: descSource, description_target: descTarget,
                source_language: langSource, target_language: langTarget,
            };
            await gameRelationshipsCollection.create(payload);
            setTargetGame(null); setSelectedOptionValue(''); setLanguage1(''); setLanguage2(''); setDescriptionThis(''); setDescriptionOther('');
            await fetchRelationships();
        } catch (err: any) {
            console.error("ModeratorPanel: Add relationship failed", { selectedOption: selectedOptionValue, thisGameId: selectedGame.id, otherGameId: targetGame?.id, error: err }); // Заменено на console.error
            alert(`Failed to add relationship: ${err.message || 'Unknown error'}`);
        } finally { setIsAdding(false); }
    };

    return (
        <Box sx={{ mt: 3, borderTop: '1px solid #555', pt: 2 }}>
            <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}> Game Relationships </Typography>

            {isLoading && <CircularProgress size={24} />}
            {error && <Typography color="error">{error}</Typography>}
            {!isLoading && !error && relationships.length === 0 && ( <Typography variant="body2" sx={{ color: '#aaa' }}>No relationships found.</Typography> )}
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
                                            This game {formatRelationshipForModerator(rel, selectedGame.id)}
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

            <Typography variant="subtitle2" sx={{ color: '#ccc', mt: 2, mb: 1 }}> Add New Relationship </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                 <Autocomplete
                    options={availableTargetGames}
                    getOptionLabel={(option) => `${option.title || 'Untitled'} (ID: ${option.id})`}
                    value={targetGame}
                    onChange={(_, newValue) => setTargetGame(newValue)}
                    renderInput={(params) => (
                        <TextField {...params} label="Select Other Game" variant="outlined" size="small"/>
                    )}
                    sx={{
                        '& .MuiOutlinedInput-root': {
                            '& fieldset': { borderColor: '#aaa' },
                            '&:hover fieldset': { borderColor: '#ccc' },
                            '&.Mui-focused fieldset': { borderColor: 'primary.main' },
                        },
                        '& .MuiInputLabel-root': { color: '#aaa' },
                        '& .MuiAutocomplete-input': { color: '#e0e0e0' },
                        '& .MuiAutocomplete-popupIndicator': { color: '#aaa'},
                        '& .MuiAutocomplete-clearIndicator': { color: '#aaa'}
                    }}
                    slotProps={{ paper: { sx: { bgcolor: '#333', color: '#e0e0e0' } } }}
                 />

                 <Select
                    value={selectedOptionValue}
                    onChange={(event: SelectChangeEvent) => setSelectedOptionValue(event.target.value as string)}
                    displayEmpty
                    fullWidth
                    size="small"
                    sx={{
                        color: selectedOptionValue ? '#e0e0e0' : '#aaa',
                        '& .MuiOutlinedInput-notchedOutline': { borderColor: '#aaa' },
                        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#ccc' },
                        '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'primary.main' },
                        '& .MuiSelect-icon': { color: '#aaa' }
                    }}
                    MenuProps={{ PaperProps: { sx: { backgroundColor: '#333', color: '#e0e0e0' } } }}
                 >
                     <MenuItem value="" disabled><em>Select Relationship Between THIS and OTHER Game</em></MenuItem>
                     {RELATIONSHIP_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
                     ))}
                 </Select>

                 {selectedOption?.dbType === 'Translation' && (
                     <Box sx={{ display: 'flex', gap: 1 }}>
                         <TextField
                             label="Language 1 (Original)"
                             value={language1}
                             onChange={(e) => setLanguage1(e.target.value)}
                             variant="outlined" size="small" fullWidth
                             InputLabelProps={{ style: { color: '#aaa' } }}
                             InputProps={{ style: { color: '#e0e0e0' } }}
                             sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
                             helperText={selectedOption.swapSourceTarget ? "Lang of OTHER" : "Lang of THIS"}
                             FormHelperTextProps={{sx:{color:'#888'}}}
                         />
                         <TextField
                             label="Language 2 (Translated)"
                             value={language2}
                             onChange={(e) => setLanguage2(e.target.value)}
                             variant="outlined" size="small" fullWidth
                             InputLabelProps={{ style: { color: '#aaa' } }}
                             InputProps={{ style: { color: '#e0e0e0' } }}
                             sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
                             helperText={selectedOption.swapSourceTarget ? "Lang of THIS" : "Lang of OTHER"}
                             FormHelperTextProps={{sx:{color:'#888'}}}
                         />
                     </Box>
                 )}

                 <TextField
                     label="Description Shown on THIS Game's Page (Optional)"
                     value={descriptionThis} onChange={(e) => setDescriptionThis(e.target.value)}
                     variant="outlined" size="small" fullWidth multiline minRows={1} maxRows={3}
                     InputLabelProps={{ style: { color: '#aaa' } }}
                     InputProps={{ style: { color: '#e0e0e0' } }}
                     sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
                     helperText="Describes the link TO the OTHER game."
                     FormHelperTextProps={{sx:{color:'#888'}}}
                 />
                 <TextField
                     label="Description Shown on OTHER Game's Page (Optional)"
                     value={descriptionOther} onChange={(e) => setDescriptionOther(e.target.value)}
                     variant="outlined" size="small" fullWidth multiline minRows={1} maxRows={3}
                     InputLabelProps={{ style: { color: '#aaa' } }}
                     InputProps={{ style: { color: '#e0e0e0' } }}
                     sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
                     helperText="Describes the link BACK TO this game."
                     FormHelperTextProps={{sx:{color:'#888'}}}
                 />

                <Button
                    variant="contained"
                    color="secondary"
                    onClick={handleAdd}
                    disabled={!targetGame || !selectedOptionValue || isAdding}
                    startIcon={isAdding ? <CircularProgress size={20} color="inherit" /> : null}
                >
                    Add Relationship
                </Button>
            </Box>
        </Box>
    );
};

export default GameRelationshipEditor;