// src/components/CyoaPage/GameDetails.tsx

import { useState, useEffect, useMemo, useRef, useContext } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { requestSearchAuthor } from '../../utils/searchTagBus';
import { GameEditDialog, BumpDialog } from './GameEditDialog';

import { Container, Typography, Box, CircularProgress, Grid2, Paper, Snackbar } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';
import Comments from './Comments/Comments';
import GameAdditionalInfo from './GameAdditionalInfo';
import LanguageSwitcher, { LangOption } from './LanguageSwitcher';
import {
  AuthContext,
  Game,
  GameRelationship,
  gameRelationshipsCollection,
  GameVariant,
  gameVariantsCollectionPublic,
  VARIANT_FIELDS,
  isFreshOriginal,
  markPinnedSeen,
  resolveGameByParam,
  gameCanonicalKey,
} from '../../pocketbase/pocketbase';
import { getPrefLang, setPrefLang, langLabel } from '../../utils/langPref';
import { LOAD_BUILD_EVENT } from '../../utils/cheat';
import DOMPurify from 'dompurify';
import CyoaCompanionDrawer from './CyoaCompanionDrawer';
import { cfImage, cfImageSrcSet } from '../../utils/cfImage';
import { recordGameView } from '../../utils/gameViews';
import { splitGameAliases } from '../../utils/aliases';

// The detail cover sits in a half-width column (md+) inside a maxWidth="lg" (1200px)
// container, full width below md. Candidate widths + matching sizes let the browser
// pick the right one. DETAIL_IMG_WIDTH is the plain `src` fallback (a member of the list).
const DETAIL_IMG_WIDTHS = [400, 600, 800, 1200];
const DETAIL_IMG_WIDTH = 600;
const DETAIL_IMG_SIZES = '(max-width: 900px) 96vw, 580px';

export default function GameDetails() {
  const [game, setGame] = useState<Game | null>(null);
  const [relatedGames, setRelatedGames] = useState<GameRelationship[]>([]);
  const [variants, setVariants] = useState<GameVariant[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [imageSrc, setImageSrc] = useState<string>('');
  const [imageSrcSet, setImageSrcSet] = useState<string | undefined>(undefined);
  // Режим редактирования тегов: состояние общее для TagDisplay и кнопки-тоггла,
  // которая живёт в ряду иконок GameAdditionalInfo.
  const [editingTags, setEditingTags] = useState<boolean>(false);
  // Opt-in cheat companion: hosted games always load with the saver shim (see
  // GameContent); the "Cheats" button in GameAdditionalInfo flips this, which
  // upgrades that shim to the full cheat menu over postMessage — no reload.
  const [cheatsOn, setCheatsOn] = useState<boolean>(false);
  // The shim announces itself once it recognizes the game's engine; only then
  // does the Cheats button appear (an unsupported engine never announces, so
  // nobody is offered a dead click).
  const [cheatReady, setCheatReady] = useState<boolean>(false);
  const [cheatSnack, setCheatSnack] = useState<string | null>(null);
  // A build string awaiting hand-off to the shim (set by a "Load" click on a
  // build card); cleared once the bridge has pushed it into the game.
  const [pendingLoadCode, setPendingLoadCode] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const theme = useTheme();

  // Canonical-redirect guard: when we resolve a legacy-id / retired-slug URL to a
  // game and rewrite the address bar to /game/<slug>, the :id param changes and
  // re-runs the fetch effect. We stash the canonical key we just loaded here so
  // that re-run short-circuits instead of refetching the same game. Only ever set
  // for the one tick between navigate() and the remount.
  const skipRefetchKeyRef = useRef<string | null>(null);

  // Управление карточкой: владелец (uploader) или модератор. Правки/бампы идут
  // через Go-эндпоинты (game_edits.go) — каждая пишет откатываемую ревизию.
  const { user, isModerator } = useContext(AuthContext);
  const isOwner = Boolean(user && game?.uploader && game.uploader === user.id);
  const canManage = isModerator || isOwner;
  const [editOpen, setEditOpen] = useState(false);
  const [bumpOpen, setBumpOpen] = useState(false);
  // Инкремент перезапускает fetchGameData (после сохранения правки/бампа).
  const [reloadKey, setReloadKey] = useState(0);

  // Reset cheat state whenever the game changes.
  useEffect(() => {
    setCheatsOn(false);
    setCheatReady(false);
    setPendingLoadCode(null);
  }, [id]);

  const handleCheatReady = () => setCheatReady(true);

  // "Load" on a build card → queue the build string; the bridge pushes it to the
  // already-loaded saver shim (see GameContent). No mode switch needed — loading
  // a build is a stock player feature, not a cheat.
  useEffect(() => {
    const onLoad = (e: Event) => {
      const code = (e as CustomEvent<{ code?: string }>).detail?.code;
      if (!code) return;
      setPendingLoadCode(code);
    };
    window.addEventListener(LOAD_BUILD_EVENT, onLoad);
    return () => window.removeEventListener(LOAD_BUILD_EVENT, onLoad);
  }, []);

  // A Load click on a game whose shim never comes up (unsupported engine or a
  // very slow load) shouldn't just silently do nothing: tell the user.
  useEffect(() => {
    if (!pendingLoadCode || cheatReady) return;
    const t = window.setTimeout(() => {
      setPendingLoadCode(null);
      setCheatSnack("Couldn't load the build – this game's engine isn't supported.");
    }, 12000);
    return () => window.clearTimeout(t);
  }, [pendingLoadCode, cheatReady]);
  // Tapping an author name collects it as a catalog filter in the header search
  // (see searchTagBus). Live everywhere since the unified header shipped.
  const authorTapToSearch = true;

  // ── Мультиязычность (гибрид): резолв активного языка + подмена контента ──
  // Оригинал живёт inline в `game`; переводы/версии — в `variants`. Идентичность
  // (комменты/теги/лайки/аналитика) ВСЕГДА на каноне; меняется только контент.
  const originalLang = (game?.language || 'en').toLowerCase();

  // Пилюли: оригинал + уникальные языки вариантов (в порядке появления).
  const langOptions: LangOption[] = useMemo(() => {
    if (!game) return [];
    const langs = [originalLang];
    for (const v of variants) {
      const l = (v.language || '').toLowerCase();
      if (l && !langs.includes(l)) langs.push(l);
    }
    return langs.map((l) => ({ key: l, label: langLabel(l) }));
  }, [game, variants, originalLang]);

  // Приоритет: URL ?lang= → сохранённая преференция → язык оригинала.
  // (getPrefLang читается здесь; клик по пилюле пишет и pref, и ?lang → ре-рендер.)
  const urlLang = searchParams.get('lang');
  const activeLang = useMemo(() => {
    const available = langOptions.map((o) => o.key);
    const url = urlLang?.toLowerCase();
    if (url && available.includes(url)) return url;
    const pref = getPrefLang()?.toLowerCase();
    if (pref && available.includes(pref)) return pref;
    return originalLang;
  }, [langOptions, urlLang, originalLang]);

  // Активный вариант (null = показываем оригинал из `game`). Для языка с несколькими
  // версиями берём version-less, иначе первый — версии в UI пока не переключаем (MVP).
  const activeVariant: GameVariant | null = useMemo(() => {
    if (!game || activeLang === originalLang) return null;
    const matches = variants.filter((v) => (v.language || '').toLowerCase() === activeLang);
    return matches.find((v) => !v.version_label) || matches[0] || null;
  }, [game, variants, activeLang, originalLang]);

  const displayTitle = activeVariant?.title || game?.title || 'Untitled Game';
  const sanitizedDescription = useMemo(() => {
    const html = activeVariant?.description || game?.description;
    return html ? DOMPurify.sanitize(html) : '';
  }, [activeVariant, game]);

  // Альт-названия карточки (games.aliases, по одному в строке): под каким ещё
  // именем эту CYOA знают — переиздания, переводы, кличка из треда. Ищутся
  // наравне с title (см. Header/SearchPage), но НЕ равны ему: показываем
  // приглушённой строкой над тегами. Поле канона, у языковых вариантов своё
  // название живёт в переключателе. Разделитель — только перевод строки
  // (запятые в названиях обычны, ср. normalizeAliases в game_edits.go).
  const altTitles = useMemo(() => splitGameAliases(game?.aliases), [game?.aliases]);

  // Обложка: берём из варианта, только если у него есть СВОЯ image (иначе — канон).
  // Одна запись-источник даёт согласованные collectionId+id+image+base64 для file-URL.
  const coverRecord = useMemo(
    () => (activeVariant && activeVariant.image ? activeVariant : game),
    [activeVariant, game],
  );

  // Запись для тела игры (iframe / статик-страницы). Идентичность канона сохраняем,
  // но id+collectionId+контент берём из варианта, чтобы file-URL резолвился верно.
  const contentGame: Game | null = useMemo(() => {
    if (!game) return null;
    if (!activeVariant) return game;
    return {
      ...game,
      id: activeVariant.id,
      collectionId: activeVariant.collectionId,
      img_or_link: activeVariant.img_or_link || game.img_or_link,
      iframe_url: activeVariant.iframe_url || '',
      cyoa_pages: activeVariant.cyoa_pages || [],
      cyoa_pages_preview: activeVariant.cyoa_pages_preview || [],
    };
  }, [game, activeVariant]);

  // Клик по пилюле: запоминаем как ГЛОБАЛЬНУЮ преференцию + отражаем в URL (шарабельно).
  const handleSelectLang = (lang: string) => {
    setPrefLang(lang);
    const next = new URLSearchParams(searchParams);
    next.set('lang', lang);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;

    // We just canonical-redirected onto this slug and already hold the game —
    // the param change re-ran this effect, so short-circuit instead of refetching.
    if (id && skipRefetchKeyRef.current === id) {
      skipRefetchKeyRef.current = null;
      return;
    }

    const fetchGameData = async () => {
      if (!id) {
          setLoading(false);
          console.error('Game id/slug is missing');
          return;
      }
      setLoading(true);
      setGame(null);
      setRelatedGames([]);
      setVariants([]);

      try {
        // Resolve the URL segment (legacy record id / current slug / retired slug)
        // to the canonical game first. Variants and relationships are keyed on the
        // real record id, which a slug in the URL doesn't hand us directly.
        const gameData = await resolveGameByParam(id);
        if (cancelled) return;
        const recordId = gameData.id;

        // Only id+title of the related game is rendered (RelatedGamesList) — without
        // a whitelist each expanded game drags its own upvotes array + tag taxonomy.
        const REL_FIELDS =
          'id,relationship_type,source_game,target_game,description_source,description_target,source_language,target_language';

        const [outgoingRelationships, incomingRelationships, variantsData] = await Promise.all([
          gameRelationshipsCollection.getFullList({
            filter: `source_game = "${recordId}"`,
            expand: 'target_game',
            fields: `${REL_FIELDS},expand.target_game.id,expand.target_game.slug,expand.target_game.title`,
          }).catch(err => {
            console.error('Failed to fetch outgoing relationships:', err);
            return [];
          }),
          gameRelationshipsCollection.getFullList({
            filter: `target_game = "${recordId}"`,
            expand: 'source_game',
            fields: `${REL_FIELDS},expand.source_game.id,expand.source_game.slug,expand.source_game.title`,
          }).catch(err => {
            console.error('Failed to fetch incoming relationships:', err);
            return [];
          }),
          // Language/version variants of the game (public read, whitelisted fields).
          gameVariantsCollectionPublic.getFullList<GameVariant>({
            filter: `game = "${recordId}"`,
            fields: VARIANT_FIELDS,
          }).catch(err => {
            console.error('Failed to fetch game variants:', err);
            return [] as GameVariant[];
          }),
        ]);
        if (cancelled) return;

        setGame(gameData);
        const validOutgoing = Array.isArray(outgoingRelationships) ? outgoingRelationships : [];
        const validIncoming = Array.isArray(incomingRelationships) ? incomingRelationships : [];
        setRelatedGames([...validOutgoing, ...validIncoming]);
        setVariants(Array.isArray(variantsData) ? variantsData : []);

        // Canonical redirect: legacy ids and retired slugs get rewritten to
        // /game/<slug>, preserving the current query (?lang=…) and hash. Pure
        // client-side replace — no round-trip; the guard at the top of this effect
        // keeps the remount from refetching what we just loaded.
        const canonicalKey = gameCanonicalKey(gameData);
        if (id !== canonicalKey) {
          skipRefetchKeyRef.current = canonicalKey;
          navigate(`/game/${canonicalKey}${window.location.search}${window.location.hash}`, {
            replace: true,
          });
        }
      } catch (error) {
        if (!cancelled) console.error('Failed to load game details:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchGameData();
    return () => { cancelled = true; };
  }, [id, reloadKey]);

  // Заголовок вкладки + аналитика. document.title грузится асинхронно, поэтому
  // page_view для страниц игр шлём здесь (App.tsx эти роуты пропускает), когда
  // название уже известно — тогда в отчёте GA4 «Pages and screens» видно конкретную игру.
  useEffect(() => {
    if (!game) return;
    const gameTitle = game.title || 'Untitled Game';
    document.title = `${gameTitle} – CYOA.CAFE`;

    window.gtag?.('event', 'page_view', {
      page_location: window.location.href,
      page_title: document.title,
    });
    // Лёгкое кастомное событие — отдельный отчёт «топ игр» по item_name/item_id.
    window.gtag?.('event', 'select_content', {
      content_type: 'game',
      item_id: game.id,
      item_name: gameTitle,
    });
    // First-party счётчик просмотров (не режется адблоком; дедуп на сессию).
    recordGameView(game.id);

    // «Посмотрел свежий релиз → откреплён у этого юзера». Отмечаем просмотренным
    // только сами оригиналы в окне закрепа (иначе плодили бы строки на каждый
    // просмотр). Fire-and-forget: сервер (залогинен) или localStorage (аноним).
    if (isFreshOriginal(game)) markPinnedSeen(game.id);

    return () => { document.title = 'CYOA.CAFE'; };
  }, [game]);

  // Canonical + hreflang. No SSR / react-helmet here, so we manage these <head>
  // links by hand. Old ids and retired slugs already client-redirect to
  // /game/<slug>, but a crawler that indexed an old URL still needs the canonical
  // to consolidate signal onto the pretty one. Query junk (utm, ?v=) is dropped;
  // only ?lang= survives, since a translation is its own indexable page.
  useEffect(() => {
    if (!game) return;
    const key = gameCanonicalKey(game);
    const base = `${window.location.origin}/game/${key}`;
    // Original language lives at the bare slug; every other language hangs off ?lang=.
    const langHref = (l: string) =>
      l === originalLang ? base : `${base}?lang=${encodeURIComponent(l)}`;

    const links: HTMLLinkElement[] = [];
    const addLink = (rel: string, href: string, hreflang?: string) => {
      const el = document.createElement('link');
      el.rel = rel;
      el.href = href;
      if (hreflang) el.hreflang = hreflang;
      el.setAttribute('data-game-head', '');
      document.head.appendChild(el);
      links.push(el);
    };

    // Canonical: a translation view is self-canonical; the original view canonicals
    // to the bare slug.
    addLink('canonical', langHref(activeLang));

    // hreflang only means anything once a game actually has more than one language.
    if (langOptions.length > 1) {
      for (const o of langOptions) addLink('alternate', langHref(o.key), o.key);
      addLink('alternate', base, 'x-default');
    }

    return () => { links.forEach((el) => el.remove()); };
  }, [game, langOptions, activeLang, originalLang]);

  useEffect(() => {
    if (!coverRecord) return;

    // Обложку резолвим из активной записи-источника (вариант или канон), чтобы
    // file-URL /api/files/{collectionId}/{id}/{image} указывал в нужную коллекцию.
    const collectionId = coverRecord.collectionId || '5kxdvx071c10s2t';
    const imageURL = coverRecord.image
      ? `/api/files/${collectionId}/${coverRecord.id}/${coverRecord.image}`
      : '';
    // Cloudflare-resized variant served on the detail page; original kept as fallback.
    const transformedURL = imageURL ? cfImage(imageURL, { width: DETAIL_IMG_WIDTH }) : '';
    const transformedSrcSet = imageURL ? cfImageSrcSet(imageURL, DETAIL_IMG_WIDTHS) : undefined;

    if (coverRecord.image_base64) {
      setImageSrc(
        coverRecord.image_base64.startsWith('data:')
          ? coverRecord.image_base64
          : `data:image/jpeg;base64,${coverRecord.image_base64}`
      );
      setImageSrcSet(undefined);
    }

    const showFull = () => {
      setImageSrc(transformedURL);
      setImageSrcSet(transformedSrcSet);
    };

    if (imageURL && coverRecord.image_base64) {
      const img = new Image();
      img.onload = showFull;
      img.onerror = () => {
        // CF transform failed — fall back to the untouched original.
        const orig = new Image();
        orig.onload = () => { setImageSrc(imageURL); setImageSrcSet(undefined); };
        orig.onerror = () => console.error('Failed to load full image, keeping base64');
        orig.src = imageURL;
      };
      img.src = transformedURL;
    } else if (imageURL && !coverRecord.image_base64) {
      showFull();
    }
  }, [coverRecord]);

  if (loading) return <CircularProgress sx={{ display: 'block', mx: 'auto', mt: 4 }} />;
  if (!game) return <Typography align="center" sx={{ mt: 4 }}>Game not found or failed to load.</Typography>;

  return (
    <Container maxWidth="lg" disableGutters sx={{ px: { xs: 1, sm: 2 } }}> 
      <Paper
        elevation={3}
        sx={{
          // --- НАСТРОЙКА ОТСТУПА ОТ КРАЯ ДО КОНТЕНТА (ВКЛЮЧАЯ TITLE) ---
          // xs: 2 = 16px (мобилки), md: 3 = 24px (ПК)
          p: { xs: 2, md: 2 }, 
          mb: 0,
          bgcolor: theme.palette.background.paper,
          color: theme.palette.common.white,
          borderRadius: 2
        }}
      >
        {/* Header Section: Title & Author */}
        <Box
          sx={{
            mb: 2,
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' }, 
            justifyContent: 'center',
            alignItems: { xs: 'center', md: 'flex-end' }, 
            gap: { xs: 0.5, md: 1 }, 
            textAlign: { xs: 'center', md: 'left' }
          }}
        >
          <Typography 
            variant="h4" 
            component="h1" 
            sx={{ 
              color: theme.palette.text.primary,
              fontSize: { xs: '1.75rem', md: '2.125rem' },
              lineHeight: 1.2
            }}
          >
            {displayTitle}
          </Typography>
          
          {game.expand?.authors?.length && game.expand.authors?.length > 0 && (
            <Typography 
              variant="subtitle1" 
              sx={{ 
                color: '#ff5252', // Цвет Имени автора (Красный)
                fontWeight: 600,
                mb: { xs: 0, md: '0.15em' } 
              }}
            >
              {/* Слово "by" делаем стандартным цветом текста */}
              <span style={{ color: theme.palette.text.secondary, fontWeight: 400 }}>by </span>
              {game.expand.authors.map((author, i) => (
                <Box component="span" key={`${author.name}-${i}`}>
                  {i > 0 && (
                    <span style={{ color: theme.palette.text.secondary, fontWeight: 400 }}>, </span>
                  )}
                  <Box
                    component="span"
                    onClick={authorTapToSearch ? () => requestSearchAuthor(author.name) : undefined}
                    sx={{
                      ...(authorTapToSearch && {
                        cursor: 'pointer',
                        '&:hover': { textDecoration: 'underline' },
                      }),
                    }}
                  >
                    {author.name}
                  </Box>
                </Box>
              ))}
            </Typography>
          )}
        </Box>

        {/* Переключатель языка/версии (рендерится только при >1 языке) */}
        <LanguageSwitcher options={langOptions} activeKey={activeLang} onSelect={handleSelectLang} />

        <Grid2 container spacing={3}>
          {/* Image Section */}
          <Grid2 size={{ xs: 12, md: 6 }}>
            {imageSrc && (
              <Box
                sx={{
                  width: '100%',
                  // md+: fixed height keeps the two columns aligned (image is letterboxed).
                  // Below md (single column): height follows the image so it fills the
                  // full card width instead of being letterboxed inside a fixed box.
                  height: { xs: 'auto', md: '500px' },
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  position: 'relative',
                  borderRadius: 2,
                  overflow: 'hidden'
                }}
              >
                <Box
                  component="img"
                  ref={imgRef}
                  src={imageSrc}
                  srcSet={imageSrcSet}
                  sizes={imageSrcSet ? DETAIL_IMG_SIZES : undefined}
                  alt={displayTitle}
                  sx={{
                    display: 'block',
                    width: '100%',
                    height: { xs: 'auto', md: '100%' },
                    // Guard very tall images on mobile so they don't dominate the screen.
                    maxHeight: { xs: '80vh', md: 'none' },
                    objectFit: 'contain',
                    transition: 'opacity 0.3s ease-in-out',
                    filter: imageSrc.startsWith('data:') ? 'blur(4px)' : 'none',
                  }}
                />
              </Box>
            )}
          </Grid2>

          {/* Info Section */}
          <Grid2 size={{ xs: 12, md: 6 }}>
            {altTitles.length > 0 && (
              <Typography
                variant="caption"
                sx={{
                  display: 'block',
                  mb: 1,
                  color: 'text.secondary',
                  opacity: 0.75,
                  fontStyle: 'italic',
                  lineHeight: 1.4,
                }}
              >
                Also known as: {altTitles.join(' · ')}
              </Typography>
            )}
            {game.expand?.tags?.length && game.expand.tags?.length > 0 && (
              <Box>
                <TagDisplay
                  tags={game.expand.tags}
                  gameId={game.id}
                  editing={editingTags}
                />
              </Box>
            )}
            <GameAdditionalInfo
              gameId={game.id}
              upvoteCount={game.upvotes_count ?? 0}
              relatedGames={relatedGames}
              gameType={(contentGame ?? game).img_or_link}
              gameUrl={(contentGame ?? game).iframe_url}
              originalLink={game.original_link}
              canEditTags={Boolean(game.expand?.tags?.length)}
              tagsEditing={editingTags}
              onToggleTagsEdit={() => setEditingTags((v) => !v)}
              cheatsActive={cheatsOn}
              onToggleCheats={() => setCheatsOn((v) => !v)}
              cheatReady={cheatReady}
              canManage={canManage}
              bumpedAt={game.bumped_at}
              onEditGame={() => setEditOpen(true)}
              onBumpGame={() => setBumpOpen(true)}
            />
          </Grid2>
        </Grid2>

        {/* Description Section */}
        {/* --- НАСТРОЙКА ОТСТУПА МЕЖДУ КНОПКАМИ И ОПИСАНИЕМ --- */}
        {/* mt: 3 = 24px. Меняй значение 3 на 2 или 4, чтобы уменьшить/увеличить */}
        <Box sx={{ mt: 1 }}>
          <Typography 
            variant="h6" 
            gutterBottom 
            textAlign="center" 
            sx={{ color: theme.palette.text.primary, opacity: 0.9 }}
          >
            Description
          </Typography>
          <Box
            sx={{ 
              px: { xs: 0, md: 2 }, 
              color: theme.palette.text.primary,
              '& p': { mb: 1.5, lineHeight: 1.6 },
              fontSize: { xs: '0.95rem', md: '1rem' }
            }}
            dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
          />
        </Box>
      </Paper>

      <Box sx={{ mb: 3, mt: 3 }}>
        <GameContent
          game={contentGame ?? game}
          cheatsActive={cheatsOn}
          onCheatReady={handleCheatReady}
          loadCode={pendingLoadCode}
          onLoadSent={() => setPendingLoadCode(null)}
        />
      </Box>

      <Box sx={{ pb: 4 }}>
        <Comments game={game} />
      </Box>
      
      {game && game.img_or_link === 'img' && (
        <CyoaCompanionDrawer gameId={game.id} />
      )}

      {canManage && game && (
        <>
          <GameEditDialog
            key={`edit-${game.id}-${reloadKey}`}
            open={editOpen}
            onClose={() => setEditOpen(false)}
            game={game}
            isModerator={isModerator}
            isOwner={isOwner}
            onSaved={() => setReloadKey((k) => k + 1)}
          />
          <BumpDialog
            open={bumpOpen}
            onClose={() => setBumpOpen(false)}
            game={game}
            isModerator={isModerator}
            onBumped={() => setReloadKey((k) => k + 1)}
          />
        </>
      )}

      <Snackbar
        open={Boolean(cheatSnack)}
        autoHideDuration={5000}
        onClose={() => setCheatSnack(null)}
        message={cheatSnack ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Container>

    
  );
}