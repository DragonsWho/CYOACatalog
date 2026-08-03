// src/components/CyoaPage/GameAdditionalInfo.tsx
import { useState, useEffect, useCallback, useContext } from 'react';
import { Box, Typography, CircularProgress, Tooltip, IconButton, Menu, MenuItem, ListItemText, Snackbar, Button } from '@mui/material';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import { useTheme } from '@mui/material/styles';
import { AuthContext, authedFetch, gamesCollection, usersCollection, pb, GameRelationship } from '../../pocketbase/pocketbase';
import { analytics } from '../../utils/analytics';
import RelatedGamesList from './RelatedGamesList';
import { useNavigate } from 'react-router-dom';
import { MOD_KINDS } from '../Moderation/modKinds';

// Иконки
import FilterNoneIcon from '@mui/icons-material/FilterNone';
import PublicIcon from '@mui/icons-material/Public'; // «Открыть оригинальную ссылку-первоисточник»
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined'; // «Call a moderator»
import LocalOfferOutlinedIcon from '@mui/icons-material/LocalOfferOutlined'; // «Edit tags» toggle
import EditOutlinedIcon from '@mui/icons-material/EditOutlined'; // «Edit game» (владелец/модер)
import KeyboardDoubleArrowUpIcon from '@mui/icons-material/KeyboardDoubleArrowUp'; // «Bump»
import DieIcon from '../DieIcon'; // «Cheats» toggle — the same six-pip die as the in-game FAB
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined'; // «Hide from my feed»
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';       // «Show again» (когда уже скрыта)
import { BUMP_COOLDOWN_MS } from './GameEditDialog';
import BumpVoteWidget from './BumpVoteWidget'; // «Голосование за бамп» — билетик рулетки

const LOGIN_TOOLTIP = 'Login to upvote';

// Единый источник иконки по хосту ссылки — для ОБЕИХ кнопок (iframe игры и original_link).
// Хостинги (neocities/nekoweb) → их СТАБИЛЬНАЯ бренд-иконка (фавиконки конкретных сайтов на
// них ненадёжны/совпадают — напр. neocities-сайт мог унаследовать наш favicon); наш хостинг →
// наш логотип; любой другой отдельный сайт → его собственная фавиконка (через сервис фавиконок).
// Раньше iframe-кнопка всегда рисовала логотип cyoa.cafe (враньё для neocities-ссылок), а у
// original_link чужие сайты сваливались в безликий глобус — теперь у обеих единая логика.
type HostBadge = { src: string; alt: string; tooltip: string };
function hostBadge(url: string | undefined, verb: string): HostBadge | null {
  let host = '';
  try { host = new URL(url || '').hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const on = (suffix: string) => host === suffix || host.endsWith('.' + suffix);
  if (on('neocities.org')) return { src: '/icons/neocities.ico', alt: 'Neocities', tooltip: `${verb} — Neocities` };
  if (on('nekoweb.org'))  return { src: '/icons/nekoweb.ico',  alt: 'Nekoweb',  tooltip: `${verb} — Nekoweb` };
  if (on('cyoa.cafe'))    return { src: '/favicon.svg', alt: 'cyoa.cafe', tooltip: verb };
  // Отдельный сайт — его собственная фавиконка (DuckDuckGo icon-сервис, без ключей/трекинга).
  return { src: `https://icons.duckduckgo.com/ip3/${host}.ico`, alt: host, tooltip: `${verb} — ${host}` };
}

// Ведёт ли ссылка на НАШ хостинг (cyoa.cafe)? Нужно, чтобы не рисовать вторую
// одинаковую иконку: скрипт при обновлении/перезаливке иногда дублирует cafe-ссылку
// в games.original_link, и тогда обе кнопки (iframe_url и original_link) ведут на нас.
function isInternalHost(url: string | undefined): boolean {
  let host = '';
  try { host = new URL(url || '').hostname.toLowerCase(); } catch { return false; }
  return host === 'cyoa.cafe' || host.endsWith('.cyoa.cafe');
}

// Рендер иконки бейджа с фолбэком на глобус, если фавиконка не подгрузилась (битый /favicon).
function HostIcon({ badge }: { badge: HostBadge }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PublicIcon />;
  return (
    <Box
      component="img"
      src={badge.src}
      alt={badge.alt}
      onError={() => setFailed(true)}
      sx={{ width: 24, height: 24, objectFit: 'contain' }}
    />
  );
}

interface GameAdditionalInfoProps {
  gameId: string;
  upvoteCount: number;
  relatedGames: GameRelationship[];
  onUpvoteChange?: () => void;
  // --- НОВЫЕ ПРОПСЫ ---
  gameType?: 'img' | 'link'; // Тип игры: картинка или ссылка
  gameUrl?: string;          // Ссылка на игру на НАШЕМ хостинге (iframe_url)
  originalLink?: string;     // Оригинальная ссылка-первоисточник (games.original_link)
  // Тоггл режима редактирования тегов (состояние живёт в GameDetails).
  canEditTags?: boolean;
  tagsEditing?: boolean;
  onToggleTagsEdit?: () => void;
  // Тоггл встроенного чит-компаньона (состояние живёт в GameDetails).
  cheatsActive?: boolean;
  onToggleCheats?: () => void;
  // Шим объявился из iframe (движок поддержан) — только тогда рисуем кнопку.
  cheatReady?: boolean;
  // Управление карточкой (владелец/модер): открытие диалогов живёт в GameDetails.
  canManage?: boolean;
  bumpedAt?: string;
  onEditGame?: () => void;
  onBumpGame?: () => void;
}

export default function GameAdditionalInfo({
  gameId,
  upvoteCount: initialUpvoteCount,
  relatedGames,
  onUpvoteChange,
  gameType,
  gameUrl,
  originalLink,
  canEditTags,
  tagsEditing,
  onToggleTagsEdit,
  cheatsActive,
  onToggleCheats,
  cheatReady,
  canManage,
  bumpedAt,
  onEditGame,
  onBumpGame,
}: GameAdditionalInfoProps) {
  const theme = useTheme();
  const navigate = useNavigate();
  const [isUpvoted, setIsUpvoted] = useState(false);
  const [localUpvoteCount, setLocalUpvoteCount] = useState(initialUpvoteCount || 0);
  const [isLoading, setIsLoading] = useState(false);
  const [showLoader, setShowLoader] = useState(false);
  const { user, blockedGameIds } = useContext(AuthContext);
  const userID = user?.id;

  // Персональный блеклист: спрятана ли эта игра у текущего юзера.
  const isHidden = blockedGameIds.includes(gameId);
  const [hideLoading, setHideLoading] = useState(false);
  // Snackbar с действием Undo после скрытия/возврата.
  const [snack, setSnack] = useState<{ open: boolean; msg: string; undo: (() => void) | null }>({
    open: false,
    msg: '',
    undo: null,
  });

  useEffect(() => {
    setLocalUpvoteCount(initialUpvoteCount || 0);
  }, [initialUpvoteCount]);

  // "Did I upvote this game?" — the full `upvotes` array no longer ships with the
  // game record (see GAME_DETAIL_FIELDS). Resolve it with a tiny id-only query
  // (~70 B) instead of pulling every upvoter. Anon users are never upvoted.
  useEffect(() => {
    if (!userID) {
      setIsUpvoted(false);
      return;
    }
    let cancelled = false;
    gamesCollection
      .getList(1, 1, {
        filter: `id = "${gameId}" && upvotes ~ "${userID}"`,
        fields: 'id',
      })
      .then((res) => {
        if (!cancelled) setIsUpvoted(res.totalItems > 0);
      })
      .catch(() => {
        if (!cancelled) setIsUpvoted(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userID, gameId]);

  const handleUpvote = useCallback(async () => {
    if (!userID || isLoading) return;

    setIsLoading(true);
    const loaderTimeout = setTimeout(() => setShowLoader(true), 200);

    const originalIsUpvoted = isUpvoted;
    const originalCount = localUpvoteCount;

    const newIsUpvoted = !isUpvoted;
    setIsUpvoted(newIsUpvoted);
    setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount + 1 : Math.max(0, prevCount - 1)));
    analytics.gameUpvote({ game_id: gameId, active: newIsUpvoted });

    try {
      const res = await authedFetch('/api/custom/upvotes/' + gameId, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Upvote failed');
      
      const resJSON = await res.json();
      if (resJSON.count !== undefined) setLocalUpvoteCount(resJSON.count);
      if (onUpvoteChange) onUpvoteChange();

    } catch(error) {
        console.error("Failed to upvote:", error);
        setIsUpvoted(originalIsUpvoted);
        setLocalUpvoteCount(originalCount);
    } finally {
      clearTimeout(loaderTimeout);
      setShowLoader(false);
      setIsLoading(false);
    }
  }, [gameId, isUpvoted, localUpvoteCount, onUpvoteChange, userID, isLoading]);

  // Скрыть/показать игру в персональном блеклисте. Пишем relation-модификаторами
  // `+`/`-` (без гонок за полный массив), затем authRefresh пересчитает
  // blockedGameIds в App через authStore.onChange.
  const setBlacklisted = useCallback(
    async (hide: boolean) => {
      if (!userID || hideLoading) return;
      setHideLoading(true);
      try {
        await usersCollection.update(userID, hide ? { 'blocked_games+': gameId } : { 'blocked_games-': gameId });
        await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
        setSnack({
          open: true,
          msg: hide ? 'Hidden from your feed' : 'Shown again',
          undo: () => setBlacklisted(!hide),
        });
      } catch (error) {
        console.error('Failed to update blocked games:', error);
        setSnack({ open: true, msg: 'Failed to update – try again', undo: null });
      } finally {
        setHideLoading(false);
      }
    },
    [userID, gameId, hideLoading],
  );

  const handleSimilarSearch = () => {
      navigate(`/search?similar=${gameId}`);
  };

  // «Call a moderator» — choosing a category drops the user into the comments
  // with a guided @moderator template (see Comments.tsx ?call=mod handling).
  const [modAnchor, setModAnchor] = useState<null | HTMLElement>(null);
  const pickModKind = (kind: string) => {
    setModAnchor(null);
    navigate({ search: `?call=mod&kind=${kind}`, hash: '#comment-form' });
  };

  // --- ЛОГИКА КНОПОК ОТКРЫТИЯ ИГРЫ ---
  // 1) Игра на НАШЕМ хостинге (iframe_url) — открыть в новой вкладке без cafe-обвязки.
  const handleOpenHosted = () => {
    if (gameUrl) {
      window.open(gameUrl, '_blank', 'noopener,noreferrer');
    }
  };
  // 2) Оригинальная ссылка-первоисточник (games.original_link) — где игра лежит «в дикой природе».
  const handleOpenOriginal = () => {
    if (originalLink) {
      window.open(originalLink, '_blank', 'noopener,noreferrer');
    }
  };

  const isInteractive = gameType === 'link' && gameUrl;

  // Иконки обеих кнопок — через единый hostBadge (см. верх файла).
  const gameBadge = hostBadge(gameUrl, 'Open the game in a new tab');
  const originalBadge = hostBadge(originalLink, 'Open the original source');

  // Обе ссылки ведут на наш хостинг → original_link продублировал cafe-ссылку
  // (артефакт перезаливки). Вторую одинаковую иконку не показываем — оставляем только
  // кнопку хостинга (см. isInternalHost вверху файла).
  const originalDuplicatesHosted = isInternalHost(gameUrl) && isInternalHost(originalLink);

  const heartColor = theme.palette.secondary.main;

  return (
    <Box sx={{ mt: 2 }}>
      {/* Блок кнопок — переносится на новую строку на узких экранах (мобилка),
          иначе длинная модерская панель торчала вправо и ломала вёрстку. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, minHeight: 40, mb: 1 }}>
        
        {/* Кнопка лайка */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip title={userID ? (isUpvoted ? 'Remove upvote' : 'Upvote') : LOGIN_TOOLTIP} arrow>
            <span>
                <IconButton
                onClick={handleUpvote}
                disabled={isLoading || !userID}
                size="small"
                sx={{
                    padding: 0,
                    width: 36,
                    height: 36,
                    opacity: !userID ? 0.6 : 1,
                    '&:hover': { backgroundColor: !userID || isLoading ? 'transparent' : 'rgba(255, 255, 255, 0.08)' },
                    display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                }}
                >
                {showLoader && <CircularProgress size={24} color="inherit" sx={{ position: 'absolute', zIndex: 1 }} />}
                <Box sx={{ width: 72, height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: showLoader ? 0 : 1 }}>
                    <DotLottieReact key={isUpvoted ? 'upvoted' : 'not-upvoted'} src="/like.lottie" loop={false} autoplay={isUpvoted} style={{ width: '72px', height: '72px', color: heartColor }} />
                </Box>
                </IconButton>
            </span>
            </Tooltip>
            <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold', minWidth: 10, textAlign: 'left' }}>
                {localUpvoteCount}
            </Typography>
        </Box>

        {/* Голосование за бамп (рулетка) — билетик + число уже отданных голосов */}
        <BumpVoteWidget gameId={gameId} />

        {/* Кнопка поиска похожих */}
        <Tooltip title="Find similar games" arrow>
            <IconButton 
                onClick={handleSimilarSearch}
                size="small"
                sx={{
                    width: 36, 
                    height: 36,
                    color: theme.palette.primary.light, 
                    '&:hover': {
                        backgroundColor: theme.palette.action.hover,
                        color: theme.palette.primary.main,
                        borderColor: theme.palette.primary.main
                    }
                }}
            >
                <FilterNoneIcon fontSize="small" />
            </IconButton>
        </Tooltip>

        {/* --- КНОПКА 1: Открыть игру (iframe_url) в новой вкладке. Иконка = по реальному
            хосту: наш логотип для cyoa.cafe, бренд-иконка для neocities/nekoweb, фавиконка
            сайта для прочих (см. hostBadge). --- */}
        {isInteractive && gameBadge && (
            <Tooltip title={gameBadge.tooltip} arrow>
                <IconButton
                    onClick={handleOpenHosted}
                    size="small" // Сам размер кнопки оставляем small (чтобы круг был 36-40px)
                    sx={{
                        width: 36,
                        height: 36,
                        color: theme.palette.primary.light,
                        '&:hover': {
                            backgroundColor: theme.palette.action.hover,
                            color: theme.palette.primary.main,
                            borderColor: theme.palette.primary.main
                        }
                    }}
                >
                    <HostIcon badge={gameBadge} />
                </IconButton>
            </Tooltip>
        )}

        {/* --- КНОПКА 2: Открыть ОРИГИНАЛЬНУЮ ссылку-первоисточник (games.original_link).
            Показываем только если ссылка вообще есть (у части игр её нет / протухла).
            Иконка — та же логика hostBadge: бренд-иконка хостинга или фавиконка сайта. --- */}
        {originalLink && originalBadge && !originalDuplicatesHosted && (
            <Tooltip title={originalBadge.tooltip} arrow>
                <IconButton
                    onClick={handleOpenOriginal}
                    size="small"
                    sx={{
                        width: 36,
                        height: 36,
                        color: theme.palette.primary.light,
                        '&:hover': {
                            backgroundColor: theme.palette.action.hover,
                            color: theme.palette.primary.main,
                            borderColor: theme.palette.primary.main
                        }
                    }}
                >
                    <HostIcon badge={originalBadge} />
                </IconButton>
            </Tooltip>
        )}

        {/* «Cheats» — переключает уже загруженный saver-шим в чит-меню (postMessage,
            без перезагрузки игры). Кнопка появляется, когда шим объявился из iframe —
            т.е. игра на нашем хостинге и её движок поддержан. */}
        {cheatReady && onToggleCheats && (
          <Tooltip title={cheatsActive ? 'Hide cheats' : 'Cheats (post a build to unlock)'} arrow>
            <IconButton
              onClick={onToggleCheats}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: '#fff',
                backgroundColor: cheatsActive ? theme.palette.action.selected : 'transparent',
                '&:hover': { backgroundColor: theme.palette.action.hover },
              }}
            >
              <DieIcon size={22} />
            </IconButton>
          </Tooltip>
        )}

        {/* «Call a moderator» — единственная иконка-флажок, открывает меню категорий */}
        <Tooltip title="Report a problem (call a moderator)" arrow>
          <IconButton
            onClick={(e) => setModAnchor(e.currentTarget)}
            size="small"
            sx={{
              width: 36,
              height: 36,
              color: 'text.disabled',
              '&:hover': { backgroundColor: theme.palette.action.hover, color: '#d25353' },
            }}
          >
            <FlagOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        {/* «Edit game» + «Bump» — только владелец (uploader) или модератор.
            Тултип бампа показывает, КОГДА можно снова (не голое «нельзя»). */}
        {canManage && onEditGame && (
          <Tooltip title="Edit game (title, description, images…)" arrow>
            <IconButton
              onClick={onEditGame}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: theme.palette.primary.light,
                '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.primary.main },
              }}
            >
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {canManage && onBumpGame && (() => {
          const nextBump = bumpedAt
            ? new Date(new Date(bumpedAt.replace(' ', 'T')).getTime() + BUMP_COOLDOWN_MS)
            : null;
          const onCooldown = nextBump !== null && nextBump.getTime() > Date.now();
          const tip = onCooldown
            ? `Update bump – next available ${nextBump!.toLocaleDateString()}`
            : 'Update bump – updated the game? Bump it to the top';
          return (
            <Tooltip title={tip} arrow>
              <IconButton
                onClick={onBumpGame}
                size="small"
                sx={{
                  width: 36,
                  height: 36,
                  color: onCooldown ? 'text.disabled' : theme.palette.primary.light,
                  '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.primary.main },
                }}
              >
                <KeyboardDoubleArrowUpIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          );
        })()}

        {/* «Edit tags» — тоггл режима голосования за теги (только для залогиненных) */}
        {userID && canEditTags && (
          <Tooltip title={tagsEditing ? 'Done editing tags' : 'Edit tags'} arrow>
            <IconButton
              onClick={onToggleTagsEdit}
              size="small"
              sx={{
                width: 36,
                height: 36,
                color: tagsEditing ? theme.palette.success.light : theme.palette.primary.light,
                backgroundColor: tagsEditing ? theme.palette.action.selected : 'transparent',
                '&:hover': {
                  backgroundColor: theme.palette.action.hover,
                  color: tagsEditing ? theme.palette.success.main : theme.palette.primary.main,
                },
              }}
            >
              <LocalOfferOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}

        {/* «Спрятать от себя» — персональный тихий блеклист (только залогиненным).
            Никаких счётчиков: просто убирает игру из всех списков этого юзера. */}
        {userID && (
          <Tooltip title={isHidden ? 'Show again in my feed' : 'Hide from my feed'} arrow>
            <span>
              <IconButton
                onClick={() => setBlacklisted(!isHidden)}
                disabled={hideLoading}
                size="small"
                sx={{
                  width: 36,
                  height: 36,
                  color: isHidden ? theme.palette.secondary.light : 'text.disabled',
                  '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.secondary.main },
                }}
              >
                {isHidden ? <VisibilityOutlinedIcon fontSize="small" /> : <VisibilityOffOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        )}

        <Menu
          anchorEl={modAnchor}
          open={Boolean(modAnchor)}
          onClose={() => setModAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        >
          <MenuItem disabled sx={{ opacity: 0.7, fontSize: '0.8rem' }}>
            What’s wrong with this game?
          </MenuItem>
          {MOD_KINDS.map((k) => (
            <Tooltip key={k.kind} title={k.hint} placement="right" arrow>
              <MenuItem onClick={() => pickModKind(k.kind)}>
                <ListItemText primary={k.label} />
              </MenuItem>
            </Tooltip>
          ))}
        </Menu>

      </Box>

      <RelatedGamesList relationships={relatedGames} currentGameId={gameId} />

      <Snackbar
        open={snack.open}
        autoHideDuration={5000}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={snack.msg}
        action={
          snack.undo ? (
            <Button
              color="secondary"
              size="small"
              onClick={() => {
                const fn = snack.undo;
                setSnack((s) => ({ ...s, open: false }));
                fn?.();
              }}
            >
              Undo
            </Button>
          ) : null
        }
      />
    </Box>
  );
}