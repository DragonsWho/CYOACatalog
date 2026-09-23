import React from 'react';
import { Box, Typography, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { GameRelationship, Game, gameCanonicalKey } from '../../pocketbase/pocketbase';

interface RelatedGamesListProps {
  relationships: GameRelationship[];
  currentGameId: string;
}

// Pick the description by direction: outgoing relation (current = source) shows the source
// description, incoming (current = target) the target description.
const getRelativeRelationship = (relationship: GameRelationship, currentGameId: string): {
    relatedGame: Game;
    relativeTypeLabel: string;
    displayDescription?: string;
    source_language?: string;
    target_language?: string;
} | null => {
    let relatedGame: Game | undefined = undefined;
    let relativeTypeLabel: string = relationship.relationship_type;
    let displayDescription: string | undefined = undefined;

    if (relationship.source_game === currentGameId && relationship.expand?.target_game?.id) {
        relatedGame = relationship.expand.target_game;
        displayDescription = relationship.description_source;
        switch (relationship.relationship_type) {
            case 'Translation': relativeTypeLabel = 'Translation'; break;
            case 'Expansion': relativeTypeLabel = 'Expansion'; break;
            case 'Sequel': relativeTypeLabel = 'Sequel'; break;
            case 'Interactive Port': relativeTypeLabel = 'Interactive Port'; break;
            case 'Static Port': relativeTypeLabel = 'Static Port'; break;
            case 'DLC': relativeTypeLabel = 'DLC'; break;
            case 'Inspired By': relativeTypeLabel = 'Inspired Game'; break;
            case 'Version': relativeTypeLabel = 'Updated Version'; break;
            default: relativeTypeLabel = relationship.relationship_type;
        }
    } else if (relationship.target_game === currentGameId && relationship.expand?.source_game?.id) {
        relatedGame = relationship.expand.source_game;
        displayDescription = relationship.description_target;
        switch (relationship.relationship_type) {
            case 'Translation': case 'Interactive Port': case 'Static Port':
                relativeTypeLabel = 'Original Version'; break;
            case 'Sequel': relativeTypeLabel = 'Prequel'; break;
            case 'Expansion': case 'DLC':
                relativeTypeLabel = 'Base Game'; break;
            case 'Inspired By': relativeTypeLabel = 'Inspiration'; break;
            case 'Version': relativeTypeLabel = 'Previous Version'; break;
            default: relativeTypeLabel = `Source (${relationship.relationship_type})`;
        }
    } else { return null; }

    if (!relatedGame) { return null; }

    return {
        relatedGame,
        relativeTypeLabel,
        displayDescription,
        source_language: relationship.source_language,
        target_language: relationship.target_language,
    };
};

export default function RelatedGamesList({ relationships, currentGameId }: RelatedGamesListProps): JSX.Element | null {
    const validRelativeRelationships = relationships
        .map(rel => getRelativeRelationship(rel, currentGameId))
        .filter((rel): rel is Exclude<ReturnType<typeof getRelativeRelationship>, null> => rel !== null);

    if (validRelativeRelationships.length === 0) { return null; }

    const groupedRelationships = validRelativeRelationships.reduce<Record<string, typeof validRelativeRelationships>>((acc, current) => {
        const { relativeTypeLabel } = current;
        if (!acc[relativeTypeLabel]) { acc[relativeTypeLabel] = []; }
        if (!acc[relativeTypeLabel].some(item => item.relatedGame.id === current.relatedGame.id)) {
            acc[relativeTypeLabel].push(current);
        }
        return acc;
    }, {});

    const sortedTypeLabels = Object.keys(groupedRelationships).sort((a, b) => a.localeCompare(b));

    return (
        <Box sx={{ mt: 2 }}>
            {sortedTypeLabels.map(label => (
                <Box key={label} sx={{ mb: 0.5 }}>
                    <Typography variant="body2" sx={{ color: 'text.secondary', display: 'inline' }}>
                        {label}:{' '}
                    </Typography>
                    <Box sx={{ display: 'inline' }}>
                        {groupedRelationships[label].map(({
                            relatedGame,
                            displayDescription,
                            source_language,
                            target_language
                        }, index, arr) => (
                            <React.Fragment key={relatedGame.id}>
                                <Link component={RouterLink} to={`/game/${gameCanonicalKey(relatedGame)}`} variant="body2" sx={{ color: 'primary.light', '&:hover': { color: 'primary.main', textDecoration: 'underline' }, }} >
                                    {relatedGame.title || 'Untitled Game'}
                                </Link>

                                {label === 'Translation' && target_language && ( <Typography variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>({target_language})</Typography> )}
                                {label === 'Original Version' && source_language && ( <Typography variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>(from {source_language})</Typography> )}

                                {displayDescription && (
                                    <Typography variant="caption" sx={{ color: 'text.disabled', ml: 0.5 }} >
                                        ({displayDescription}){' '}
                                    </Typography>
                                )}

                                {index < arr.length - 1 && <Typography variant="body2" component="span" sx={{ color: 'text.secondary', ml: 0.5 }}>,</Typography>}
                            </React.Fragment>
                        ))}
                    </Box>
                </Box>
            ))}
        </Box>
    );
}