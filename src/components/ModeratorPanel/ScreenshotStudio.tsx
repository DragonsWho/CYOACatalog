// /moderator/screenshots — browser-based replacement for the local Puppeteer catalog screenshot
// tool; capture happens in the moderator's browser, nothing to install. The game runs in an iframe
// with a real 1920×2560 viewport. On Capture the moderator shares this tab via getDisplayMedia();
// the tool shows the iframe 1:1, captures tiles, stitches a 1920×2560 canvas and downscales to
// 960×1280 WebP (catalog format). Result is downloaded locally for now; PocketBase upload can be
// wired after quality is verified. Ported from the standalone screenshot_studio.html prototype —
// keep capture behavior identical. Moderator UI is English.
// Mod Tools opens this page as ?url=<game>&handoff=<id>; "Use as cover" then posts the capture back
// over a BroadcastChannel (same origin, no upload round-trip).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Container, GlobalStyles, Paper, Stack, TextField, Typography,
} from '@mui/material';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import RefreshIcon from '@mui/icons-material/Refresh';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { COVER_HANDOFF_CHANNEL, CoverHandoffMessage } from '../ModTools/coverHandoff';

const SOURCE_W = 1920;
const SOURCE_H = 2560;
const OUTPUT_W = 960;
const OUTPUT_H = 1280;
const PLACEHOLDER_W = 100;
const PLACEHOLDER_H = 133;
const URL_STORAGE_KEY = 'cyoa-screenshot-studio-url';
// Namespaced class (can't collide with other capture-mode classes); freezes page scroll while the
// fixed capture surface is active.
const CAPTURE_CLASS = 'ss-capture-mode';

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the tab video stream.')), 5000);
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function waitForFreshVideoFrame(video: HTMLVideoElement): Promise<void> {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    return Promise.race([
      new Promise<void>((resolve) => {
        (video as unknown as { requestVideoFrameCallback: (cb: () => void) => void })
          .requestVideoFrameCallback(() => resolve());
      }),
      wait(250),
    ]);
  }
  return wait(140);
}

// Tiles overlap slightly to avoid hairline seams from subpixel rounding.
function makeStops(total: number, viewport: number, overlap = 64): number[] {
  if (viewport >= total) return [0];
  const maxStart = total - viewport;
  const step = Math.max(1, viewport - overlap);
  const stops: number[] = [];
  for (let p = 0; p < maxStart; p += step) {
    stops.push(Math.min(p, maxStart));
  }
  stops.push(maxStart);
  return [...new Set(stops.map((v) => Math.round(v)))];
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/webp', quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(`Could not create a ${type} blob.`));
    }, type, quality);
  });
}

function makePlaceholder(canvas: HTMLCanvasElement): string {
  const tiny = document.createElement('canvas');
  tiny.width = PLACEHOLDER_W;
  tiny.height = PLACEHOLDER_H;
  const ctx = tiny.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, PLACEHOLDER_W, PLACEHOLDER_H);
  return tiny.toDataURL('image/webp', 0.4);
}

interface CaptureResult {
  blob: Blob;
  placeholder: string;
  captureWidth: number;
  captureHeight: number;
  tiles: number;
}

export default function ScreenshotStudio() {
  const [urlValue, setUrlValue] = useState('');
  const [iframeSrc, setIframeSrc] = useState('');
  const [status, setStatus] = useState('preview');
  const [capturing, setCapturing] = useState(false);
  const [captureModeOn, setCaptureModeOn] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [resultUrl, setResultUrl] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy 100×133 base64 placeholder');

  const gameFrameRef = useRef<HTMLIFrameElement>(null);
  const frameZoomRef = useRef<HTMLDivElement>(null);
  const frameScaleBoxRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const captureVideoRef = useRef<HTMLVideoElement>(null);
  const previewScaleRef = useRef(0.3);
  const captureModeRef = useRef(false);

  const [handoff, setHandoff] = useState('');
  const [handoffSent, setHandoffSent] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('url');
    setHandoff(params.get('handoff') || '');
    if (fromQuery) {
      setUrlValue(fromQuery);
      try {
        setIframeSrc(new URL(fromQuery).href);
      } catch { /* invalid, user can fix it in the field */ }
      return;
    }
    try {
      const saved = localStorage.getItem(URL_STORAGE_KEY);
      if (saved) setUrlValue(saved);
    } catch { /* storage blocked */ }
  }, []);

  const setScale = useCallback((scale: number) => {
    const clamped = Math.max(0.05, Math.min(scale, 1));
    previewScaleRef.current = clamped;
    if (frameZoomRef.current) frameZoomRef.current.style.transform = `scale(${clamped})`;
    if (frameScaleBoxRef.current) {
      frameScaleBoxRef.current.style.width = `${SOURCE_W * clamped}px`;
      frameScaleBoxRef.current.style.height = `${SOURCE_H * clamped}px`;
    }
    setStatus(`preview ${(clamped * 100).toFixed(0)}% · game viewport ${SOURCE_W}×${SOURCE_H}`);
  }, []);

  const fitPreview = useCallback(() => {
    const toolbarH = toolbarRef.current?.getBoundingClientRect().height ?? 0;
    const maxW = Math.max(280, window.innerWidth - 48);
    const maxH = Math.max(280, window.innerHeight - toolbarH - 48);
    const scale = Math.min(maxW / SOURCE_W, maxH / SOURCE_H, 1);
    setScale(scale);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [setScale]);

  useEffect(() => {
    fitPreview();
    const onResize = () => {
      // Ref, not captureModeOn from the first render: the previous port captured `false` forever,
      // so any resize during sharing called fitPreview() mid-capture and scaled the iframe back
      // down.
      if (!captureModeRef.current) fitPreview();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitPreview]);

  const loadUrl = useCallback(() => {
    const raw = urlValue.trim();
    if (!raw) return;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      window.alert('Enter a full URL, e.g. https://example.com/game/');
      return;
    }
    setIframeSrc(parsed.href);
    localStorage.setItem(URL_STORAGE_KEY, parsed.href);
  }, [urlValue]);

  const reloadIframe = useCallback(() => {
    if (gameFrameRef.current?.src) {
      // eslint-disable-next-line no-self-assign
      gameFrameRef.current.src = gameFrameRef.current.src;
    }
  }, []);

  const applyCaptureMode = useCallback((enabled: boolean) => {
    captureModeRef.current = enabled;
    document.documentElement.classList.toggle(CAPTURE_CLASS, enabled);
    document.body.classList.toggle(CAPTURE_CLASS, enabled);
    setCaptureModeOn(enabled);

    const scaleBox = frameScaleBoxRef.current;
    const zoom = frameZoomRef.current;

    if (enabled) {
      // Capture must not depend on catalog page layout: the first port kept the 1920×2560 frame in
      // a centered flex container and the site's wrappers clipped large parts. Pin the EXISTING
      // iframe to the viewport (preserving game state) and move it tile by tile ourselves.
      if (zoom) zoom.style.transform = 'none';
      if (scaleBox) {
        scaleBox.style.position = 'fixed';
        scaleBox.style.left = '0';
        scaleBox.style.top = '0';
        scaleBox.style.width = `${SOURCE_W}px`;
        scaleBox.style.height = `${SOURCE_H}px`;
        scaleBox.style.margin = '0';
        scaleBox.style.padding = '0';
        scaleBox.style.zIndex = '2147483647';
        scaleBox.style.transform = 'translate3d(0, 0, 0)';
      }
    } else {
      if (scaleBox) {
        scaleBox.style.position = '';
        scaleBox.style.left = '';
        scaleBox.style.top = '';
        scaleBox.style.margin = '';
        scaleBox.style.padding = '';
        scaleBox.style.zIndex = '';
        scaleBox.style.transform = '';
      }
      setScale(previewScaleRef.current);
    }
  }, [setScale]);

  const captureIframeTiled = useCallback(async (): Promise<CaptureResult> => {
    const gameFrame = gameFrameRef.current;
    const captureVideo = captureVideoRef.current;
    if (!gameFrame || !captureVideo) throw new Error('Capture surface is not ready yet.');
    if (!gameFrame.getAttribute('src')) {
      throw new Error('Load the game into the iframe first.');
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser does not support the Screen Capture API. Try Chrome/Chromium/Edge.');
    }

    // Must run directly from the user click or the browser rejects capture.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
        displaySurface: 'browser',
      },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    } as MediaStreamConstraints);

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {} as MediaTrackSettings;

    try {
      if (settings.displaySurface && settings.displaySurface !== 'browser') {
        throw new Error('You picked something other than "Tab". For accurate cropping, share this browser tab specifically.');
      }

      captureVideo.srcObject = stream;
      await captureVideo.play();
      await waitForVideoReady(captureVideo);
      await waitForFreshVideoFrame(captureVideo);

      const oldTitle = document.title;

      applyCaptureMode(true);
      await nextPaint();
      await wait(160);

      const stitched = document.createElement('canvas');
      stitched.width = SOURCE_W;
      stitched.height = SOURCE_H;
      const ctx = stitched.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SOURCE_W, SOURCE_H);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Move the capture target itself instead of scrolling the page: independent of parent
      // max-width/overflow/flex rules.
      const xs = makeStops(SOURCE_W, window.innerWidth, 80);
      const ys = makeStops(SOURCE_H, window.innerHeight, 80);
      const totalTiles = xs.length * ys.length;
      let tileNo = 0;
      const scaleBox = frameScaleBoxRef.current;
      if (!scaleBox) throw new Error('Capture frame is not ready.');

      for (const y of ys) {
        for (const x of xs) {
          tileNo += 1;
          document.title = `Capturing ${tileNo}/${totalTiles}`;
          scaleBox.style.transform = `translate3d(${-x}px, ${-y}px, 0)`;
          await nextPaint();
          await wait(100);
          await waitForFreshVideoFrame(captureVideo);

          const rect = gameFrame.getBoundingClientRect();
          const left = Math.max(0, rect.left);
          const top = Math.max(0, rect.top);
          const right = Math.min(window.innerWidth, rect.right);
          const bottom = Math.min(window.innerHeight, rect.bottom);

          const visibleW = right - left;
          const visibleH = bottom - top;
          if (visibleW <= 0 || visibleH <= 0) continue;

          const scaleX = captureVideo.videoWidth / window.innerWidth;
          const scaleY = captureVideo.videoHeight / window.innerHeight;

          const sx = left * scaleX;
          const sy = top * scaleY;
          const sw = visibleW * scaleX;
          const sh = visibleH * scaleY;

          const dx = left - rect.left;
          const dy = top - rect.top;

          ctx.drawImage(captureVideo, sx, sy, sw, sh, dx, dy, visibleW, visibleH);
        }
      }

      const output = document.createElement('canvas');
      output.width = OUTPUT_W;
      output.height = OUTPUT_H;
      const outCtx = output.getContext('2d', { alpha: false })!;
      outCtx.fillStyle = '#000';
      outCtx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'high';
      outCtx.drawImage(stitched, 0, 0, SOURCE_W, SOURCE_H, 0, 0, OUTPUT_W, OUTPUT_H);

      const blob = await canvasToBlob(output, 'image/webp', 0.8);
      const placeholder = makePlaceholder(output);

      applyCaptureMode(false);
      await nextPaint();
      fitPreview();
      document.title = oldTitle;

      return {
        blob,
        placeholder,
        captureWidth: captureVideo.videoWidth,
        captureHeight: captureVideo.videoHeight,
        tiles: totalTiles,
      };
    } finally {
      applyCaptureMode(false);
      stream.getTracks().forEach((t) => t.stop());
      captureVideo.srcObject = null;
    }
  }, [applyCaptureMode, fitPreview]);

  const handleCapture = useCallback(async () => {
    setCapturing(true);
    setError('');
    try {
      const captured = await captureIframeTiled();
      setResult(captured);
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(captured.blob);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCapturing(false);
    }
  }, [captureIframeTiled]);

  const handleDownload = useCallback(() => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(result.blob);
    a.download = `cyoa-screenshot-${Date.now()}.webp`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }, [result]);

  const handleSendToModTools = useCallback(() => {
    if (!result || !handoff) return;
    const ch = new BroadcastChannel(COVER_HANDOFF_CHANNEL);
    const msg: CoverHandoffMessage = { handoff, blob: result.blob, placeholder: result.placeholder };
    ch.postMessage(msg);
    ch.close();
    setHandoffSent(true);
  }, [result, handoff]);

  const handleCopyPlaceholder = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.placeholder);
      setCopyLabel('Copied');
      setTimeout(() => setCopyLabel('Copy 100×133 base64 placeholder'), 1200);
    } catch {
      window.prompt('Copy manually:', result.placeholder);
    }
  }, [result]);

  return (
    <Box sx={{ mx: -4, my: -4 }}>
      <GlobalStyles
        styles={{
          [`html.${CAPTURE_CLASS}, body.${CAPTURE_CLASS}`]: {
            background: '#000',
            overflow: 'hidden',
            scrollbarWidth: 'none',
            overscrollBehavior: 'none',
          },
          [`html.${CAPTURE_CLASS}::-webkit-scrollbar, body.${CAPTURE_CLASS}::-webkit-scrollbar`]: {
            display: 'none',
            width: 0,
            height: 0,
          },
        }}
      />

      <Box
        aria-hidden
        sx={{
          display: captureModeOn ? 'block' : 'none',
          position: 'fixed',
          inset: 0,
          zIndex: 2147483646,
          bgcolor: '#000',
          pointerEvents: 'none',
        }}
      />

      <Box
        ref={toolbarRef}
        sx={{
          display: captureModeOn ? 'none' : 'grid',
          gap: 1.25,
          p: 2,
          position: 'sticky',
          top: 0,
          zIndex: 100,
          bgcolor: 'rgba(11,11,11,0.96)',
          borderBottom: '1px solid rgba(255,255,255,0.12)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <Container maxWidth="lg" disableGutters>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Screenshot Studio{' '}
            <Typography component="span" variant="caption" sx={{ color: '#888' }}>
              (moderator-only test tool · catalog screenshots)
            </Typography>
          </Typography>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 1.25 }}>
            <TextField
              size="small"
              type="url"
              placeholder="https://your-mini-host.example/game/"
              spellCheck={false}
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') loadUrl(); }}
              sx={{ flex: '1 1 480px', minWidth: 260 }}
            />
            <Button variant="outlined" onClick={loadUrl}>Load</Button>
            <Button variant="outlined" startIcon={<RefreshIcon />} onClick={reloadIframe}>
              Reload iframe
            </Button>
            <Button variant="outlined" startIcon={<FitScreenIcon />} onClick={fitPreview}>
              Fit
            </Button>
            <Button variant="outlined" onClick={() => setScale(1)}>100%</Button>
            <Button
              variant="contained"
              color="primary"
              startIcon={<PhotoCameraIcon />}
              disabled={capturing}
              onClick={handleCapture}
            >
              {capturing ? 'Capturing…' : 'Capture 3:4'}
            </Button>
          </Stack>

          {error && (
            <Alert severity="error" sx={{ mb: 1.25 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}

          <Typography variant="caption" sx={{ color: '#999', lineHeight: 1.5, display: 'block' }}>
            The game always gets a <strong>1920×2560</strong> viewport, even while the preview is
            scaled down. When you click Capture, Chrome will ask you to pick a source — choose{' '}
            <strong>This Tab</strong>. The page then briefly expands the iframe to 1:1, captures it
            in tiles, stitches them into 1920×2560, and downscales to{' '}
            <strong>960×1280 WebP, quality 0.80</strong>.
          </Typography>
        </Container>
      </Box>

      <Box
        sx={{
          minHeight: captureModeOn ? 0 : 'calc(100vh - 220px)',
          p: captureModeOn ? 0 : 3,
          display: captureModeOn ? 'block' : 'flex',
          justifyContent: captureModeOn ? 'initial' : 'center',
          alignItems: 'flex-start',
        }}
      >
        <Box
          ref={frameScaleBoxRef}
          sx={{ position: 'relative', flex: '0 0 auto' }}
        >
          <Box
            ref={frameZoomRef}
            sx={{
              width: `${SOURCE_W}px`,
              height: `${SOURCE_H}px`,
              transformOrigin: 'top left',
              position: 'relative',
            }}
          >
            <Box
              sx={{
                width: `${SOURCE_W}px`,
                height: `${SOURCE_H}px`,
                bgcolor: '#000',
                overflow: 'hidden',
                borderRadius: captureModeOn ? 0 : '14px',
                border: captureModeOn ? 0 : '1px solid rgba(255,255,255,0.12)',
                boxShadow: captureModeOn ? 'none' : '0 20px 80px rgba(0,0,0,.45)',
              }}
            >
              <iframe
                ref={gameFrameRef}
                title="Game preview"
                src={iframeSrc || undefined}
                allow="fullscreen; autoplay; clipboard-read; clipboard-write"
                referrerPolicy="no-referrer-when-downgrade"
                style={{
                  display: 'block', width: SOURCE_W, height: SOURCE_H, border: 0, background: '#000',
                }}
              />
            </Box>
          </Box>
        </Box>
      </Box>

      {result && !captureModeOn && (
        <Container maxWidth="lg" sx={{ py: 2.5 }}>
          <Paper
            elevation={3}
            sx={{
              p: 2.5, display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: 'minmax(240px, 420px) 1fr' },
              bgcolor: '#0b0b0b',
            }}
          >
            <Box
              component="img"
              src={resultUrl}
              alt="Screenshot preview"
              sx={{
                width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 1.5,
                border: '1px solid rgba(255,255,255,0.12)', bgcolor: '#000',
              }}
            />
            <Stack spacing={1.25} alignItems="flex-start">
              <Typography variant="h6" sx={{ m: 0 }}>Done</Typography>
              <Typography variant="caption" sx={{ color: '#999' }}>
                Tab source: {result.captureWidth}×{result.captureHeight}; tiles: {result.tiles};
                {' '}output: {OUTPUT_W}×{OUTPUT_H} WebP, {(result.blob.size / 1024).toFixed(1)} KiB.
              </Typography>
              {handoff && (
                <Button variant="contained" color="warning" onClick={handleSendToModTools}>
                  {handoffSent ? 'Sent — switch back to the Mod Tools tab' : 'Use as cover in Mod Tools'}
                </Button>
              )}
              <Button variant={handoff ? 'outlined' : 'contained'} color="success" startIcon={<DownloadIcon />} onClick={handleDownload}>
                Download WebP
              </Button>
              <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={handleCopyPlaceholder}>
                {copyLabel}
              </Button>
              <Typography variant="caption" sx={{ color: '#777' }}>
                Testing tool — the capture only downloads for now. Wiring it up to send{' '}
                straight to PocketBase (instead of a manual download) is future work.
              </Typography>
            </Stack>
          </Paper>
        </Container>
      )}

      {!captureModeOn && (
        <Box
          sx={{
            position: 'fixed', right: 14, bottom: 14, zIndex: 200, px: 1.25, py: 1,
            borderRadius: 1.5, bgcolor: 'rgba(11,11,11,0.95)', border: '1px solid rgba(255,255,255,0.12)',
            color: '#999', fontSize: 12, pointerEvents: 'none',
          }}
        >
          {status}
        </Box>
      )}

      <video ref={captureVideoRef} muted playsInline style={{
        position: 'fixed', width: 1, height: 1, left: -20, top: -20, opacity: 0, pointerEvents: 'none',
      }}
      />
    </Box>
  );
}