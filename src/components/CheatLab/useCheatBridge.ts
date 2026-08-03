// Parent half of the cheat "save a build to unlock" gate.
//
// The cheat UI lives inside the game iframe (cheat_shim.js, on author.cyoa.cafe)
// and cannot read the user's cyoa.cafe session, so the parent page handles the
// two things that need it: checking whether the user already has a build for
// this game (the gate) and saving a new one. Every build is a record in the
// `builds` registry (see buildsApi.ts); a PUBLIC build is additionally mirrored
// as a comment with a fenced ```cyoa-build block, a PRIVATE one unlocks the
// cheats without appearing in the thread. Communication with the shim is
// postMessage, origin-locked to the iframe's own origin.
//
// Protocol:
//   shim  -> parent : { source:'cyoacafe-cheat', kind:'ready' }
//                     { source:'cyoacafe-cheat', kind:'postBuild', build:{code,summary},
//                       isPublic?, newBuild? }          (isPublic default true)
//   parent -> shim  : { source:'cyoacafe-cheat-host', kind:'hello' }              (immediate)
//                     { source:'cyoacafe-cheat-host', kind:'gate', gameId, unlocked }
//                     { source:'cyoacafe-cheat-host', kind:'mode', mode:'save'|'cheat' }
//                     { source:'cyoacafe-cheat-host', kind:'buildResult', ok, isPublic, error? }
//
// The shim starts in the mode its inject flag implies (?__save=1 → saver,
// ?__cheat=1 → cheat) and the parent can switch it live with a 'mode' message —
// that's how the Cheats toggle upgrades the always-on saver sheet to the full
// cheat menu without reloading the game (selections survive).
//
// Used on the real game page (GameContent, always enabled for our own hosted
// games — the saver sheet needs the bridge from the first load) and by
// /cheat-lab (no gameId → the game is resolved from the loaded URL).
import { useEffect, useRef, RefObject } from 'react';
import { pb, gamesCollectionPublic } from '../../pocketbase/pocketbase';
import { type CheatBuild } from '../CyoaPage/Comments/buildComment';
import { hasAnyBuild, saveBuild } from '../CyoaPage/Comments/buildsApi';
import { announceBuildPosted } from '../../utils/cheat';
import { analytics } from '../../utils/analytics';

interface CheatBridgeOptions {
  src: string;          // current iframe src (used for the target origin + lab URL match)
  gameId?: string;      // known games record id (real page); omit to resolve from src (lab)
  enabled?: boolean;    // default true; false makes the hook fully inert
  mode?: 'save' | 'cheat'; // shim UI mode; changes are pushed live (no reload)
  onReady?: () => void; // fired when the shim announces itself (engine is supported)
  loadCode?: string | null; // a build string to push into the game once the shim is ready
  onLoadSent?: () => void;   // fired after loadCode has been handed to the shim (clear it)
}

function iframeOrigin(src: string): string {
  try {
    return new URL(src).origin;
  } catch {
    return '';
  }
}

// The catalog embeds a game by its iframe_url; strip our ?__cheat=1 flag and any
// trailing slash so we can match it back to the games record.
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
  const { src, gameId: knownGameId, enabled = true, mode, onReady, loadCode, onLoadSent } = opts;
  const gameIdRef = useRef<string | null>(null);
  const resolvedRef = useRef(false);
  // Kept in refs so changing values/identities don't re-subscribe the listener.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const loadCodeRef = useRef(loadCode);
  loadCodeRef.current = loadCode;
  const onLoadSentRef = useRef(onLoadSent);
  onLoadSentRef.current = onLoadSent;
  // Whether the shim has announced itself in the current enabled session, and a
  // stable handle to "push the pending build if we can" so a Load click that
  // arrives while the shim is already up (cheats already on) still fires.
  const shimReadyRef = useRef(false);
  const trySendLoadRef = useRef<(() => void) | null>(null);
  const sendModeRef = useRef<(() => void) | null>(null);

  // Resolve the games record for the loaded URL when the caller didn't hand us a
  // gameId (the /cheat-lab case). On the real page knownGameId is authoritative.
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
        /* not in the catalog: gameId stays null, gate stays locked */
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

    // Fresh iframe (this effect re-runs on src/enabled change): the shim hasn't
    // announced yet. `trySendLoad` pushes a pending build string to the shim once
    // it has — called both from the ready handler and from the loadCode effect
    // (for a Load click while the shim is already up).
    shimReadyRef.current = false;
    const trySendLoad = (): void => {
      if (!shimReadyRef.current) return;
      const code = loadCodeRef.current;
      if (!code) return;
      send({ kind: 'loadBuild', code });
      onLoadSentRef.current?.();
    };
    trySendLoadRef.current = trySendLoad;
    // Push the caller's current mode to the shim (no-op before it's ready; the
    // ready handler sends the initial one). Lets the Cheats toggle flip the
    // already-loaded saver shim into the cheat menu and back without a reload.
    const sendMode = (): void => {
      if (!shimReadyRef.current || !modeRef.current) return;
      send({ kind: 'mode', mode: modeRef.current });
    };
    sendModeRef.current = sendMode;

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
      };
      if (!d || d.source !== 'cyoacafe-cheat') return;

      if (d.kind === 'ready') {
        send({ kind: 'hello' }); // immediate: stops the shim's standalone-unlock timer
        onReadyRef.current?.(); // the shim only announces on a supported engine
        await waitResolved();
        const gid = gameIdRef.current;
        const uid = pb.authStore.model?.id;
        const unlocked = gid && uid ? await hasAnyBuild(gid, uid) : false;
        send({ kind: 'gate', gameId: gid, unlocked });
        shimReadyRef.current = true;
        sendMode();    // sync the shim to the caller's current mode
        trySendLoad(); // flush a build queued before the shim came up
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
        try {
          // Default: overwrite the user's existing build for this game so the
          // thread keeps one build per player. `newBuild` (an explicit opt-in in
          // the cheat menu) saves a separate record/comment instead. isPublic
          // omitted (old shims, "Update my build") keeps the record's visibility.
          const rec = await saveBuild({ gameId: gid, build, isPublic: d.isPublic, forceNew: d.newBuild });
          analytics.cheatBuildSaved({ game_id: gid, is_public: !!rec.public });
          send({ kind: 'buildResult', ok: true, isPublic: rec.public });
          send({ kind: 'gate', gameId: gid, unlocked: true });
          // Refresh the thread either way: a new public build appears in it, and
          // going private may remove a previously public one.
          announceBuildPosted(gid);
        } catch (err) {
          send({
            kind: 'buildResult',
            ok: false,
            error: err instanceof Error ? err.message : 'Could not save the build.',
          });
        }
      }
    };

    const listener = (e: MessageEvent): void => void onMessage(e);
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      trySendLoadRef.current = null;
      sendModeRef.current = null;
    };
  }, [src, iframeRef, enabled]);

  // Mode flips (Cheats on/off) while the shim is already up: push the change.
  useEffect(() => {
    if (mode) sendModeRef.current?.();
  }, [mode]);

  // A Load click can land after the shim is already up (cheats already on): the
  // message effect won't re-run, so nudge the pending-build flush here too.
  useEffect(() => {
    if (loadCode) trySendLoadRef.current?.();
  }, [loadCode]);
}
