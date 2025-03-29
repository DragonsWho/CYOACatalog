// src/components/CyoaPage/RelatedGamesList.tsx
import React from 'react';
import { Box, Typography, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { GameRelationship, Game } from '../../pocketbase/pocketbase'; // Тип GameRelationship теперь включает языки

interface RelatedGamesListProps {
  relationships: GameRelationship[];
  currentGameId: string;
}

// Обновляем возвращаемый тип и логику для извлечения языков
const getRelativeRelationship = (relationship: GameRelationship, currentGameId: string): {
    relatedGame: Game;
    relativeTypeLabel: string;
    description?: string;
    source_language?: string; // Добавляем
    target_language?: string; // Добавляем
} | null => {
    let relatedGame: Game | undefined = undefined;
    let relativeTypeLabel: string = relationship.relationship_type;

    // ИСХОДЯЩИЕ
    if (relationship.source_game === currentGameId && relationship.expand?.target_game?.id) {
        relatedGame = relationship.expand.target_game;
        switch (relationship.relationship_type) {
            case 'Translation': relativeTypeLabel = 'Translation'; break;
            case 'Expansion': relativeTypeLabel = 'Expansion'; break;
            case 'Sequel': relativeTypeLabel = 'Sequel'; break;
            case 'Interactive Port': relativeTypeLabel = 'Interactive Port'; break;
            case 'Static Port': relativeTypeLabel = 'Static Port'; break;
            case 'DLC': relativeTypeLabel = 'DLC'; break;
            case 'Inspired By': relativeTypeLabel = 'Inspired Game'; break;
            default: relativeTypeLabel = relationship.relationship_type;
        }
    // ВХОДЯЩИЕ
    } else if (relationship.target_game === currentGameId && relationship.expand?.source_game?.id) {
        relatedGame = relationship.expand.source_game;
        switch (relationship.relationship_type) {
            case 'Translation':
            case 'Interactive Port':
            case 'Static Port':
                relativeTypeLabel = 'Original Version'; break;
            case 'Sequel':
                relativeTypeLabel = 'Prequel'; break;
            case 'Expansion':
            case 'DLC':
                relativeTypeLabel = 'Base Game'; break;
            case 'Inspired By':
                relativeTypeLabel = 'Inspiration'; break;
            default: relativeTypeLabel = `Source (${relationship.relationship_type})`;
        }
    } else {
        return null;
    }

    if (!relatedGame) {
        return null;
    }

    // Возвращаем объект, включая языки из relationship
    return {
        relatedGame,
        relativeTypeLabel,
        description: relationship.description,
        source_language: relationship.source_language, // Извлекаем язык источника
        target_language: relationship.target_language, // Извлекаем язык цели
    };
};

// Компонент для отображения списка
export default function RelatedGamesList({ relationships, currentGameId }: RelatedGamesListProps): JSX.Element | null {
    // Трансформируем связи, получая объект с языками
    const validRelativeRelationships = relationships
        .map(rel => getRelativeRelationship(rel, currentGameId))
        .filter((rel): rel is Exclude<ReturnType<typeof getRelativeRelationship>, null> => rel !== null); // Уточненный type guard

    if (validRelativeRelationships.length === 0) {
        return null;
    }

    // Группируем по relativeTypeLabel. В массив добавляем объект целиком, включая языки
    const groupedRelationships = validRelativeRelationships.reduce<Record<string, typeof validRelativeRelationships>>((acc, current) => {
        const { relativeTypeLabel } = current; // Группируем по метке
        if (!acc[relativeTypeLabel]) {
            acc[relativeTypeLabel] = [];
        }
        // Добавляем весь объект current (с игрой, описанием, языками)
        if (!acc[relativeTypeLabel].some(item => item.relatedGame.id === current.relatedGame.id)) {
            acc[relativeTypeLabel].push(current);
        }
        return acc;
    }, {});

    // Сортируем ключи (метки типов связей)
    const sortedTypeLabels = Object.keys(groupedRelationships).sort((a, b) => a.localeCompare(b));

    return (
        <Box sx={{ mt: 2 }}>
            {sortedTypeLabels.map(label => (
                <Box key={label} sx={{ mb: 0.5 }}>
                    <Typography variant="body2" sx={{ color: 'text.secondary', display: 'inline' }}>
                        {label}:{' '}
                    </Typography>
                    <Box sx={{ display: 'inline' }}>
                        {/* Деструктурируем языки при итерации */}
                        {groupedRelationships[label].map(({
                            relatedGame,
                            description,
                            source_language, // Получаем язык источника
                            target_language  // Получаем язык цели
                        }, index, arr) => (
                            <React.Fragment key={relatedGame.id}>
                                <Link
                                    component={RouterLink}
                                    to={`/game/${relatedGame.id}`}
                                    variant="body2"
                                    sx={{
                                        color: 'primary.light',
                                        '&:hover': { color: 'primary.main', textDecoration: 'underline' },
                                        // Убираем правый отступ здесь, добавим после языков или описания
                                        // mr: description ? 0.5 : 0,
                                    }}
                                >
                                    {relatedGame.title || 'Untitled Game'}
                                </Link>

                                {/* --- НОВОЕ: Отображение языков для переводов --- */}
                                {/* Показываем язык перевода, если смотрим на оригинал */}
                                {label === 'Translation' && target_language && (
                                    <Typography variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
                                        ({target_language})
                                    </Typography>
                                )}
                                {/* Показываем язык оригинала, если смотрим на перевод */}
                                {label === 'Original Version' && source_language && (
                                    <Typography variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
                                        ({source_language})
                                    </Typography>
                                )}
                                {/* --- КОНЕЦ НОВОГО --- */}

                                {/* Описание, если есть (добавляем отступ слева, если не было языка) */}
                                {description && (
                                    <Typography variant="caption" sx={{
                                         color: 'text.disabled',
                                         // Добавляем отступ слева, только если языка не было показано
                                         ml: (label === 'Translation' && target_language) || (label === 'Original Version' && source_language) ? 0.5 : 0.5
                                         }}>
                                        ({description})
                                    </Typography>
                                )}

                                {/* Запятая после элемента */}
                                {index < arr.length - 1 && <Typography variant="body2" component="span" sx={{ color: 'text.secondary', ml: 0.5 /* Отступ перед запятой */ }}>,</Typography>}
                            </React.Fragment>
                        ))}
                    </Box>
                </Box>
            ))}
        </Box>
    );
}