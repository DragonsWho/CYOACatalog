import { useState, useEffect, useMemo, useRef, useContext } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { requestSearchAuthor } from '../../utils/searchTagBus';
import { GameEditDialog, BumpDialog } from './GameEditDialog';
import ModReuploadDialog from '../Hosting/ModReuploadDialog';

import { Container, Typography, Box, CircularProgress, Grid2, Paper, Snackbar } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import { webpAspect } from '../../utils/webpSize';
import GameContent from './GameContent';
import Comments from './Comments/Comments';
import SimilarGamesStrip from './SimilarGamesStrip';
import GameAbout from './GameAbout';
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
import type { FilterMode } from '../../types';
import { LOAD_BUILD_EVENT } from '../../utils/cheat';
import DOMPurify from 'dompurify';
import CyoaCompanionDrawer from './CyoaCompanionDrawer';
import { cfImage, cfImageSrcSet } from '../../utils/cfImage';
import { recordGameView } from '../../utils/gameViews';
import { splitGameAliases } from '../../utils/aliases';

// Detail cover sits in a half-width column (md+) inside maxWidth="lg" (1200px), full width below
// md. Candidate widths + sizes let the browser pick; DETAIL_IMG_WIDTH is the plain `src` fallback
// (a member of the list).
const DETAIL_IMG_WIDTHS = [400, 600, 800, 1200];
const DETAIL_IMG_WIDTH = 600;
const DETAIL_IMG_SIZES = '(max-width: 900px) 96vw, 580px';

// Data the Go shell inlines for /game/<slug> (game_inline.go): same shapes as the queries below, so
// the page renders at mount instead of after two round trips. Keyed by the canonical URL key.
interface InlineGame {
  key: string;
  game: Game;
  related: GameRelationship[];
  variants: GameVariant[];
}

// Order-insensitive deep equality for API-shaped JSON (Go and PocketBase emit keys in different order).
function sameData(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function peekInlineGame(key: string | undefined): InlineGame | null {
  const g = (window as unknown as { __GAME__?: InlineGame }).__GAME__;
  return key && g && g.key === key && g.game ? g : null;
}

export default function GameDetails({ filterMode }: { filterMode: FilterMode }) {
  const { id } = useParams<{ id: string }>();
  // Inline data for the first render only; the fetch effect then revalidates it quietly (the shell
  // is edge-cached for an hour, so an edit could otherwise hide behind it).
  const [inline] = useState(() => peekInlineGame(id));
  const [game, setGame] = useState<Game | null>(inline?.game ?? null);
  const [relatedGames, setRelatedGames] = useState<GameRelationship[]>(inline?.related ?? []);
  const [variants, setVariants] = useState<GameVariant[]>(inline?.variants ?? []);
  const [loading, setLoading] = useState<boolean>(!inline);
  const gameRef = useRef<Game | null>(game);
  gameRef.current = game;
  const [imageSrc, setImageSrc] = useState<string>('');
  const [imageSrcSet, setImageSrcSet] = useState<string | undefined>(undefined);
  // Tag edit mode is shared by TagDisplay and the toggle button in GameAdditionalInfo's icon row.
  const [editingTags, setEditingTags] = useState<boolean>(false);
  // Opt-in cheat companion: hosted games always load with the saver shim (GameContent); the
  // "Cheats" button upgrades it to the full cheat menu over postMessage — no reload.
  const [cheatsOn, setCheatsOn] = useState<boolean>(false);
  // The shim announces itself once it recognizes the engine; only then does the Cheats button
  // appear (no dead clicks on unsupported engines).
  const [cheatReady, setCheatReady] = useState<boolean>(false);
  const [cheatSnack, setCheatSnack] = useState<string | null>(null);
  // Build string awaiting hand-off to the shim (from a build card "Load"); cleared once pushed.
  const [pendingLoadCode, setPendingLoadCode] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const theme = useTheme();

  // Canonical-redirect guard: after resolving a legacy-id / retired-slug URL and rewriting to
  // /game/<slug>, the :id param change re-runs the fetch effect. The canonical key stashed here
  // makes that re-run short-circuit. Set only for the tick between navigate() and the remount.
  const skipRefetchKeyRef = useRef<string | null>(null);

  // Card management for uploader or moderator. Edits/bumps go through Go endpoints (game_edits.go);
  // each writes a reversible revision.
  const { user, isModerator } = useContext(AuthContext);
  const isOwner = Boolean(user && game?.uploader && game.uploader === user.id);
  const canManage = isModerator || isOwner;
  const [editOpen, setEditOpen] = useState(false);
  const [bumpOpen, setBumpOpen] = useState(false);
  const [reuploadOpen, setReuploadOpen] = useState(false);
  // Increment re-runs fetchGameData (after an edit/bump save).
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setCheatsOn(false);
    setCheatReady(false);
    setPendingLoadCode(null);
  }, [id]);

  const handleCheatReady = () => setCheatReady(true);

  // "Load" queues the build string; the bridge pushes it to the saver shim. No mode switch: loading
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

  // Load on a game whose shim never comes up (unsupported engine, very slow load) must not silently
  // do nothing.
  useEffect(() => {
    if (!pendingLoadCode || cheatReady) return;
    const t = window.setTimeout(() => {
      setPendingLoadCode(null);
      setCheatSnack("Couldn't load the build – this game's engine isn't supported.");
    }, 12000);
    return () => window.clearTimeout(t);
  }, [pendingLoadCode, cheatReady]);
  // Tapping an author name adds it as a catalog filter in the header search (searchTagBus).
  const authorTapToSearch = true;

  // Multilang (hybrid): resolve the active language and swap content. The original lives inline in
  // `game`; translations/versions in `variants`. Identity (comments/tags/likes/analytics) ALWAYS
  // stays on the canonical record; only content changes.
  const originalLang = (game?.language || 'en').toLowerCase();

  const langOptions: LangOption[] = useMemo(() => {
    if (!game) return [];
    const langs = [originalLang];
    for (const v of variants) {
      const l = (v.language || '').toLowerCase();
      if (l && !langs.includes(l)) langs.push(l);
    }
    return langs.map((l) => ({ key: l, label: langLabel(l) }));
  }, [game, variants, originalLang]);

  // Priority: URL ?lang= → saved preference → original language. A pill click writes both pref and
  // ?lang.
  const urlLang = searchParams.get('lang');
  const activeLang = useMemo(() => {
    const available = langOptions.map((o) => o.key);
    const url = urlLang?.toLowerCase();
    if (url && available.includes(url)) return url;
    const pref = getPrefLang()?.toLowerCase();
    if (pref && available.includes(pref)) return pref;
    return originalLang;
  }, [langOptions, urlLang, originalLang]);

  // Active variant (null = original). For a language with several versions take the version-less
  // one, else the first (MVP: no version switching in UI).
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

  // games.aliases (one per line): other names this CYOA is known by (re-releases, translations,
  // thread nicknames). Searched like title (Header/SearchPage) but NOT equal to it: shown as a
  // muted line above tags. Canonical field; variants have their own titles in the switcher.
  // Separator is newline only (commas are common in titles; cf. normalizeAliases in game_edits.go).
  const altTitles = useMemo(() => splitGameAliases(game?.aliases), [game?.aliases]);

  // Cover from the variant only if it has its OWN image, else canonical. One source record gives
  // consistent collectionId+id+image+base64 for the file URL.
  const coverRecord = useMemo(
    () => (activeVariant && activeVariant.image ? activeVariant : game),
    [activeVariant, game],
  );
  const coverAspect = useMemo(() => webpAspect(coverRecord?.image_base64), [coverRecord]);

  // Record for the game body (iframe/static pages): canonical identity kept, but
  // id+collectionId+content from the variant so file URLs resolve correctly.
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

  // Pill click: store as a GLOBAL preference + reflect in URL (shareable).
  const handleSelectLang = (lang: string) => {
    setPrefLang(lang);
    const next = new URLSearchParams(searchParams);
    next.set('lang', lang);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    let cancelled = false;

    // We just canonical-redirected onto this slug and already hold the game — short-circuit instead
    // of refetching.
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
      // Already showing this game (inline data): refresh in place — no spinner, no blanking, and
      // state is replaced only if something actually changed (a new object would re-run the cover
      // effect and flash the blur).
      const shown = gameRef.current;
      const quiet = reloadKey === 0 && shown !== null && gameCanonicalKey(shown) === id;
      if (!quiet) {
        setLoading(true);
        setGame(null);
        setRelatedGames([]);
        setVariants([]);
      }

      try {
        // Resolve the URL segment (legacy id / current slug / retired slug) to the canonical game
        // first: variants and relationships are keyed on the real record id.
        const gameData = await resolveGameByParam(id);
        if (cancelled) return;
        const recordId = gameData.id;

        // Only id+title of related games are rendered (RelatedGamesList) — without a whitelist each
        // expanded game drags its upvotes array + tag taxonomy.
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
          gameVariantsCollectionPublic.getFullList<GameVariant>({
            filter: `game = "${recordId}"`,
            fields: VARIANT_FIELDS,
          }).catch(err => {
            console.error('Failed to fetch game variants:', err);
            return [] as GameVariant[];
          }),
        ]);
        if (cancelled) return;

        const validOutgoing = Array.isArray(outgoingRelationships) ? outgoingRelationships : [];
        const validIncoming = Array.isArray(incomingRelationships) ? incomingRelationships : [];
        const nextRelated = [...validOutgoing, ...validIncoming];
        const nextVariants = Array.isArray(variantsData) ? variantsData : [];
        if (!quiet || !sameData(gameData, shown)) setGame(gameData);
        setRelatedGames((prev) => (quiet && sameData(prev, nextRelated) ? prev : nextRelated));
        setVariants((prev) => (quiet && sameData(prev, nextVariants) ? prev : nextVariants));

        // Canonical redirect: legacy ids and retired slugs → /game/<slug>, preserving query
        // (?lang=…) and hash. Client-side replace; the guard above prevents refetching.
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

  // Tab title + analytics. document.title loads async, so page_view for game pages is sent here
  // (App.tsx skips these routes) once the title is known — GA4 "Pages and screens" then shows the
  // specific game.
  useEffect(() => {
    if (!game) return;
    const gameTitle = game.title || 'Untitled Game';
    document.title = `${gameTitle} – CYOA.CAFE`;

    window.gtag?.('event', 'page_view', {
      page_location: window.location.href,
      page_title: document.title,
    });
    // Light custom event for a separate "top games" report by item_name/item_id.
    window.gtag?.('event', 'select_content', {
      content_type: 'game',
      item_id: game.id,
      item_name: gameTitle,
    });
    // First-party view counter (not blocked by adblockers; per-session dedup).
    recordGameView(game.id);

    // "Viewed a fresh release → unpinned for this user". Only originals within the pin window are
    // marked (else a row per view). Fire-and-forget: server (logged in) or localStorage (anon).
    if (isFreshOriginal(game)) markPinnedSeen(game.id);

    return () => { document.title = 'CYOA.CAFE'; };
  }, [game]);

  // Canonical + hreflang managed by hand (no SSR / react-helmet). Old ids/slugs client-redirect,
  // but a crawler that indexed an old URL still needs the canonical to consolidate onto the pretty
  // one. Query junk (utm, ?v=) dropped; only ?lang= survives (a translation is its own indexable
  // page).
  useEffect(() => {
    if (!game) return;
    const key = gameCanonicalKey(game);
    const base = `${window.location.origin}/game/${key}`;
    // Original language at the bare slug; others via ?lang=.
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

    // A translation view is self-canonical; the original canonicals to the bare slug.
    addLink('canonical', langHref(activeLang));

    // hreflang only when a game has more than one language.
    if (langOptions.length > 1) {
      for (const o of langOptions) addLink('alternate', langHref(o.key), o.key);
      addLink('alternate', base, 'x-default');
    }

    return () => { links.forEach((el) => el.remove()); };
  }, [game, langOptions, activeLang, originalLang]);

  useEffect(() => {
    if (!coverRecord) return;

    // Resolve the cover from the active source record so /api/files/{collectionId}/{id}/{image}
    // points to the right collection.
    const collectionId = coverRecord.collectionId || '5kxdvx071c10s2t';
    const imageURL = coverRecord.image
      ? `/api/files/${collectionId}/${coverRecord.id}/${coverRecord.image}`
      : '';
    // Cloudflare-resized variant on the detail page; original as fallback.
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
        // CF transform failed — fall back to the original.
        const orig = new Image();
        orig.onload = () => { setImageSrc(imageURL); setImageSrcSet(undefined); };
        orig.onerror = () => console.error('Failed to load full image, keeping base64');
        orig.src = imageURL;
      };
      // Same srcset/sizes as the <img>: the probe fetches exactly the candidate the <img> will use
      // (and the one the shell preloads) — a bare 600w probe meant a second download on 2-3x phones.
      if (transformedSrcSet) {
        img.sizes = DETAIL_IMG_SIZES;
        img.srcset = transformedSrcSet;
      }
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
          p: { xs: 2, md: 2 }, 
          mb: 0,
          bgcolor: theme.palette.background.paper,
          color: theme.palette.common.white,
          borderRadius: 2
        }}
      >
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
                color: '#ff5252',
                fontWeight: 600,
                mb: { xs: 0, md: '0.15em' } 
              }}
            >
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

        <LanguageSwitcher options={langOptions} activeKey={activeLang} onSelect={handleSelectLang} />

        <Grid2 container spacing={3}>
          <Grid2 size={{ xs: 12, md: 6 }}>
            {(imageSrc || coverAspect) && (
              <Box
                sx={{
                  width: '100%',
                  // md+: fixed height keeps columns aligned (image letterboxed). Below md: height
                  // follows the image so it fills the card width — reserved up front from the blur
                  // placeholder's proportions, else tags below jump when the image decodes (CLS).
                  height: { xs: 'auto', md: '500px' },
                  ...(coverAspect && {
                    aspectRatio: { xs: String(coverAspect), md: 'auto' },
                    maxHeight: { xs: '80vh', md: 'none' },
                  }),
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  position: 'relative',
                  borderRadius: 2,
                  overflow: 'hidden'
                }}
              >
                {imageSrc && <Box
                  component="img"
                  ref={imgRef}
                  src={imageSrc}
                  srcSet={imageSrcSet}
                  sizes={imageSrcSet ? DETAIL_IMG_SIZES : undefined}
                  alt={displayTitle}
                  sx={{
                    display: 'block',
                    width: '100%',
                    height: { xs: coverAspect ? '100%' : 'auto', md: '100%' },
                    // Guard very tall images on mobile.
                    maxHeight: { xs: '80vh', md: 'none' },
                    objectFit: 'contain',
                    transition: 'opacity 0.3s ease-in-out',
                    filter: imageSrc.startsWith('data:') ? 'blur(4px)' : 'none',
                  }}
                />}
              </Box>
            )}
          </Grid2>

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
              // Re-upload targets the canonical card (not a language variant): versions live with
              // the hosted game its iframe_url points to.
              onReuploadGame={
                isModerator && game.iframe_url ? () => setReuploadOpen(true) : undefined
              }
            />
          </Grid2>
        </Grid2>

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

      {/*
        "Other games" before the comments: after reading the description and trying the game, offer
        the next one. Also the only links from the card to the catalog — see SimilarGamesStrip.
      */}
      <SimilarGamesStrip game={game} filterMode={filterMode} />

      <Box>
        <Comments game={game} />
      </Box>

      {/*
        Game breakdown for readers and search engines at the very bottom, collapsed (why here, not
        the footer — see GameAbout).
      */}
      <GameAbout gameId={game.id} />
      
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

      {isModerator && game && (
        <ModReuploadDialog
          open={reuploadOpen}
          onClose={() => setReuploadOpen(false)}
          gameId={game.id}
          gameTitle={game.title}
        />
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