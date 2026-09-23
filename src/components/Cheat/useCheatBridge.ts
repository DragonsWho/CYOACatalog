// Parent half of the cheat "save a build to unlock" gate. The cheat UI lives inside the game iframe
// (cheat_shim.js on author.cyoa.cafe) and can't read the cyoa.cafe session, so the parent handles
// gate checks (does the user have a build for this game) and saving. Every build is a `builds`
// record (buildsApi.ts); PUBLIC builds are also mirrored as a comment with a fenced ```cyoa-build
// block; PRIVATE ones unlock cheats without appearing in the thread.
// postMessage, origin-locked to the iframe's origin. Protocol:
// shim → parent: {source:'cyoacafe-cheat', kind:'ready'} | 'fullscreen' (iOS fallback only) |
// 'expand' (immersive toggle) | 'barTakeover' {active} | 'postBuild' {build:{code,summary},
// isPublic? (default true), newBuild?}
// parent → shim: {source:'cyoacafe-cheat-host', kind:'hello'} (immediate) | 'gate' {gameId,
// unlocked} | 'mode' {mode:'save'|'cheat'} | 'viewState' {immersive, fullscreen} | 'buildResult'
// {ok, isPublic, error?, note?}
// The shim starts in the mode its inject flag implies (?__save=1 → saver, ?__cheat=1 → cheat); the
// parent switches live via 'mode' (Cheats toggle upgrades the saver sheet without reloading;
// selections survive).
// Used on the real game page (GameContent, always enabled for our hosted games) and by /cheat-lab
// (no gameId → resolved from URL).

import { useEffect, useRef, RefObject } from 'react';
import { pb, gamesCollectionPublic } from '../../pocketbase/pocketbase';
import { type CheatBuild } from '../CyoaPage/Comments/buildComment';
import { hasAnyBuild, saveBuild } from '../CyoaPage/Comments/buildsApi';
import { resolveBuildImages } from '../CyoaPage/Comments/buildImagesApi';
import { announceBuildPosted } from '../../utils/cheat';
import { analytics } from '../../utils/analytics';

interface CheatBridgeOptions {
  src: string;  // current iframe src (target origin + lab URL match)
  gameId?: string;  // known games record id (real page); omit to resolve from src (lab)
  enabled?: boolean;  // default true; false makes the hook fully inert
  mode?: 'save' | 'cheat';  // shim UI mode; changes are pushed live (no reload)
  onReady?: () => void;  // fired when the shim announces itself (engine is supported)
  loadCode?: string | null;  // a build string to push into the game once the shim is ready
  onLoadSent?: () => void;  // fired after loadCode has been handed to the shim (clear it)
  // Requested by the shim's in-bar fullscreen button ONLY when the iframe can't go fullscreen
  // (iPhone Safari has no element fullscreen). Elsewhere the shim requests it from inside the frame
  // (embed has allow="fullscreen"): user activation doesn't survive postMessage, a parent-side
  // request would be rejected.
  onFullscreenRequest?: () => void;
  // The shim's "expand to page" button: immersive mode changes the page AROUND the iframe, which
  // the shim can't reach.
  onExpandRequest?: () => void;
  // The shim replaced the game's point bar with ours (or gave it back). While ours is up it carries
  // its own expand/fullscreen buttons, so the page drops the pair it draws over that corner — from
  // outside the frame they'd sit on top and swallow clicks.
  onBarTakeover?: (active: boolean) => void;
  // Current view state pushed to the shim on every change so its buttons match — from inside the
  // iframe neither immersive mode nor iOS-fallback fullscreen is observable.
  viewState?: { immersive: boolean; fullscreen: boolean };
}

function iframeOrigin(src: string): string {
  try {
    return new URL(src).origin;
  } catch {
    return '';
  }
}

// The catalog embeds by iframe_url; strip our ?__cheat=1 flag and trailing slash to match the games
// record.
function normalizeGameUrl(src: string): string {
  try {
    const u = new URL(src);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function useCheatBridge(
  iframeRef: RefObject<HTMLIFrameElement>,
  opts: CheatBridgeOptions,
): void {
  const {
    src, gameId: knownGameId, enabled = true, mode, onReady, loadCode, onLoadSent,
    onFullscreenRequest, onExpandRequest, onBarTakeover, viewState,
  } = opts;
  const gameIdRef = useRef<string | null>(null);
  const resolvedRef = useRef(false);
  // Refs so changing values/identities don't re-subscribe the listener.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onFullscreenRef = useRef(onFullscreenRequest);
  onFullscreenRef.current = onFullscreenRequest;
  const onExpandRef = useRef(onExpandRequest);
  onExpandRef.current = onExpandRequest;
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const onBarTakeoverRef = useRef(onBarTakeover);
  onBarTakeoverRef.current = onBarTakeover;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const loadCodeRef = useRef(loadCode);
  loadCodeRef.current = loadCode;
  const onLoadSentRef = useRef(onLoadSent);
  onLoadSentRef.current = onLoadSent;
  // Shim-announced flag + stable "push pending build if possible" so a Load click while the shim is
  // already up still fires.
  const shimReadyRef = useRef(false);
  // resolveBuildImages+saveBuild take seconds (image hosting) and the shim's Save has no in-flight
  // guard — a doubled postBuild (double tap) raced two saves.
  const savingRef = useRef(false);
  const trySendLoadRef = useRef<(() => void) | null>(null);
  const sendModeRef = useRef<(() => void) | null>(null);
  const sendViewStateRef = useRef<(() => void) | null>(null);

  // Resolve the games record from the URL when no gameId was given (/cheat-lab); on the real page
  // knownGameId is authoritative.
  useEffect(() => {
    if (!enabled) return;
    if (knownGameId) {
      gameIdRef.current = knownGameId;
      resolvedRef.current = true;
      return;
    }
    gameIdRef.current = null;
    resolvedRef.current = false;
    let cancelled = false;
    const norm = normalizeGameUrl(src);
    if (!norm) {
      resolvedRef.current = true;
      return;
    }
    void (async () => {
      try {
        const rec = await gamesCollectionPublic.getFirstListItem(
          pb.filter('iframe_url ~ {:u}', { u: norm }),
          { fields: 'id' },
        );
        if (!cancelled) gameIdRef.current = rec.id;
      } catch {
      } finally {
        if (!cancelled) resolvedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, knownGameId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const origin = iframeOrigin(src);
    if (!origin) return;

    const send = (msg: Record<string, unknown>): void => {
      const w = iframeRef.current?.contentWindow;
      if (w) w.postMessage({ source: 'cyoacafe-cheat-host', ...msg }, origin);
    };

    // Fresh iframe (effect re-runs on src/enabled change): shim not announced yet. `trySendLoad` is
    // called from both the ready handler and the loadCode effect.
    shimReadyRef.current = false;
    const trySendLoad = (): void => {
      if (!shimReadyRef.current) return;
      const code = loadCodeRef.current;
      if (!code) return;
      send({ kind: 'loadBuild', code });
      onLoadSentRef.current?.();
    };
    trySendLoadRef.current = trySendLoad;
    // Push the caller's mode (no-op before ready; ready handler sends the initial one).
    const sendMode = (): void => {
      if (!shimReadyRef.current || !modeRef.current) return;
      send({ kind: 'mode', mode: modeRef.current });
    };
    sendModeRef.current = sendMode;
    const sendViewState = (): void => {
      const v = viewStateRef.current;
      if (!shimReadyRef.current || !v) return;
      send({ kind: 'viewState', immersive: v.immersive, fullscreen: v.fullscreen });
    };
    sendViewStateRef.current = sendViewState;

    // The game id may still be resolving when the shim announces 'ready'.
    const waitResolved = async (): Promise<void> => {
      for (let i = 0; i < 60 && !resolvedRef.current; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    const onMessage = async (e: MessageEvent): Promise<void> => {
      if (e.origin !== origin) return;
      const d = e.data as {
        source?: string;
        kind?: string;
        build?: CheatBuild;
        newBuild?: boolean;
        isPublic?: boolean;
        active?: boolean;
      };
      if (!d || d.source !== 'cyoacafe-cheat') return;

      if (d.kind === 'fullscreen') {
        onFullscreenRef.current?.();
        return;
      }

      if (d.kind === 'expand') {
        onExpandRef.current?.();
        return;
      }

      if (d.kind === 'barTakeover') {
        onBarTakeoverRef.current?.(!!d.active);
        return;
      }

      if (d.kind === 'ready') {
        send({ kind: 'hello' });  // immediate: stops the shim's standalone-unlock timer
        onReadyRef.current?.();  // the shim only announces on a supported engine
        await waitResolved();
        const gid = gameIdRef.current;
        const uid = pb.authStore.model?.id;
        const unlocked = gid && uid ? await hasAnyBuild(gid, uid) : false;
        send({ kind: 'gate', gameId: gid, unlocked });
        shimReadyRef.current = true;
        sendMode();
        sendViewState();
        trySendLoad();  // flush a build queued before the shim came up
        return;
      }

      if (d.kind === 'postBuild') {
        const uid = pb.authStore.model?.id;
        if (!pb.authStore.isValid || !uid) {
          send({ kind: 'buildResult', ok: false, error: 'Log in on cyoa.cafe to save a build.' });
          return;
        }
        await waitResolved();
        const gid = gameIdRef.current;
        if (!gid) {
          send({ kind: 'buildResult', ok: false, error: 'This game is not in the catalog.' });
          return;
        }
        const build = d.build;
        if (!build || !build.summary?.count) {
          send({ kind: 'buildResult', ok: false, error: 'Select at least one card first.' });
          return;
        }
        // Save takes seconds; a repeat postBuild while in flight raced a second save. Ignore
        // silently — the shim disables Save while awaiting buildResult, so this only catches stray
        // double taps.
        if (savingRef.current) return;
        savingRef.current = true;
        try {
          // Default: overwrite the user's existing build for this game (one build per player in the
          // thread). `newBuild` (explicit opt-in) saves a separate record/comment. isPublic omitted
          // (old shims, "Update my build") keeps visibility. Card pictures arrive as base64 data
          // URLs — one alone overflows the comment mirror: host them and substitute links before
          // writing. Done on the parent because it holds the PB session.
          const hosted = await resolveBuildImages(build);
          const rec = await saveBuild({
            gameId: gid, build: hosted.build, isPublic: d.isPublic, forceNew: d.newBuild,
          });
          analytics.cheatBuildSaved({ game_id: gid, is_public: !!rec.public });
          send({ kind: 'buildResult', ok: true, isPublic: rec.public, note: hosted.warning });
          send({ kind: 'gate', gameId: gid, unlocked: true });
          // Refresh the thread either way: a new public build appears; going private may remove a
          // public one.
          announceBuildPosted(gid);
        } catch (err) {
          send({
            kind: 'buildResult',
            ok: false,
            error: err instanceof Error ? err.message : 'Could not save the build.',
          });
        } finally {
          savingRef.current = false;
        }
      }
    };

    const listener = (e: MessageEvent): void => void onMessage(e);
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      trySendLoadRef.current = null;
      sendModeRef.current = null;
      sendViewStateRef.current = null;
    };
  }, [src, iframeRef, enabled]);

  useEffect(() => {
    if (mode) sendModeRef.current?.();
  }, [mode]);

  // Expanded/fullscreen flipped (either side, or Esc): tell the shim so its buttons don't go stale.
  useEffect(() => {
    sendViewStateRef.current?.();
  }, [viewState?.immersive, viewState?.fullscreen]);

  // A Load click after the shim is up: the message effect won't re-run, so flush here too.
  useEffect(() => {
    if (loadCode) trySendLoadRef.current?.();
  }, [loadCode]);
}
