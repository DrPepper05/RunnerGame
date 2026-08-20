import React, { useState, useRef, useEffect } from 'react';
import GameComponent from './GameComponent';
import GameSelectorModal from './components/GameSelectorModal';
import HudHeader from './components/HudHeader';
import CreatorPanel from './components/CreatorPanel';
import ScreenZero from './components/ScreenZero';
import { GAME_PRESETS } from './gameConfig';
import { generateGameConfig } from './game/geminiService';
import { regenerateAssetSlots } from './game/assetPipeline';
import { generateOrRestoreAssets, updateGameArt, makePromptKey, getGameById } from './game/assetCache';
import { encodeShareConfig, decodeShareConfig } from './game/shareLink';
import { generateTitle } from './game/promptUtils';
import { interpretEditPrompt, resolveAssetTargets } from './game/gameEditor';
import GameOverOverlay from './components/GameOverOverlay';
import RegenOverlay from './components/RegenOverlay';
import MobileControls from './components/MobileControls';
import * as metrics from './game/metrics';

// Capture mode (2026-08-20): a chrome-free view for recording demos and
// marketing footage. Driven by the URL so a recording setup is reproducible and
// survives the gameKey remounts that restyles and share-link restores trigger.
//   ?capture=1      — hide all chrome, keep the touch controls faintly visible
//   ?capture=clean  — also hide the touch controls (desktop/keyboard capture)
const readCaptureMode = () => {
  try {
    const value = new URLSearchParams(window.location.search).get('capture');
    if (!value || value === '0' || value === 'false') return null;
    return value === 'clean' ? 'clean' : 'on';
  } catch {
    return null;
  }
};

// The Fullscreen API is still vendor-prefixed on Safari, and the previous code
// only ever called the unprefixed form — which is why fullscreen silently did
// nothing there.
const requestFullscreenOn = (el) => {
  if (!el) return Promise.resolve();
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.msRequestFullscreen;
  try {
    return Promise.resolve(fn ? fn.call(el) : undefined);
  } catch {
    return Promise.resolve();
  }
};

const exitFullscreenNow = () => {
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  try {
    if (fullscreenElement()) return Promise.resolve(fn ? fn.call(document) : undefined);
  } catch {
    /* ignore — leaving fullscreen must never throw into the app */
  }
  return Promise.resolve();
};

const fullscreenElement = () =>
  document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;

const getInitialState = () => {
  if (typeof window !== 'undefined') {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#config=')) {
      try {
        const importedConfig = decodeShareConfig(hash.replace('#config=', ''));
        if (typeof importedConfig === 'object' && importedConfig !== null && Object.keys(importedConfig).length > 0) {
          if (!importedConfig.gameName) importedConfig.gameName = 'PlayMint Core';
          // Links carry config only — boot on built-in theme art first. If the
          // link's gameId is in this browser's asset cache, an App effect
          // upgrades the boot to the cached AI art right after (one remount).
          importedConfig.dynamicAssetUrls = null;
          return {
            presetKey: 'custom',
            liveParams: importedConfig,
            isImported: true,
            pendingRestoreId: importedConfig.gameId || null
          };
        }
      } catch (error) {
        console.error('Failed to parse config from URL:', error);
      }
    }
  }

  // Presets boot on built-in theme art (no AI generation without a prompt).
  const initialPreset = { ...GAME_PRESETS['standard'], gameName: 'PlayMint Core', dynamicAssetUrls: null };

  return { presetKey: 'standard', liveParams: initialPreset, isImported: false };
};

function App() {
  const [initialConfig] = useState(getInitialState);
  const [presetKey, setPresetKey] = useState(initialConfig.presetKey);
  const [liveParams, setLiveParams] = useState(initialConfig.liveParams);
  const [hasStarted, setHasStarted] = useState(initialConfig.isImported);
  const [regenState, setRegenState] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const fullscreenContainerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFullscreenSupported, setIsFullscreenSupported] = useState(true);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [score, setScore] = useState(0);
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [gameOverData, setGameOverData] = useState(null);
  const [gameKey, setGameKey] = useState(0);
  const [activeError, setActiveError] = useState(null);
  const [captureMode, setCaptureMode] = useState(readCaptureMode);

  // Timing telemetry (src/game/metrics.js). Two jobs, both of which have to be
  // set up before Phaser's first boot can land:
  //   1. A shared link's run starts at NAVIGATION, not at any click — that is
  //      what the "5-7s on mobile" figure actually measures.
  //   2. `phaser-load-complete` is the only signal that the scene is up. It
  //      fires once per boot, and a share link boots twice by design (theme art,
  //      then a remount onto cached art), so both are recorded on one run.
  useEffect(() => {
    if (initialConfig.isImported) {
      metrics.beginRun('sharelink', {
        gameId: initialConfig.pendingRestoreId || null,
        gameType: initialConfig.liveParams?.gameType || null
      });
      // The restore lookup below may trigger a second boot; hold the record open
      // until it resolves so a slow server fetch isn't filed as "no cached art".
      if (initialConfig.pendingRestoreId) metrics.holdRun();
    }
    const handlePlayable = () => metrics.notePlayable();
    window.addEventListener('phaser-load-complete', handlePlayable);
    return () => window.removeEventListener('phaser-load-complete', handlePlayable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handlePlaymintError = (e) => {
      const msg = e.detail?.message;
      if (msg) {
        setActiveError(msg);
      }
    };
    window.addEventListener('playmint-error', handlePlaymintError);
    return () => {
      window.removeEventListener('playmint-error', handlePlaymintError);
    };
  }, []);

  // Share-link / F5 art restore: when the imported link names a game cached in
  // THIS browser, upgrade the static boot to the cached AI art (one remount).
  // A miss changes nothing — the static boot IS the fallback.
  useEffect(() => {
    const id = initialConfig.pendingRestoreId;
    if (!id) return;
    let stale = false;
    getGameById(id).then((cached) => {
      if (stale) return;
      if (!cached) {
        // No cached art anywhere: the static boot already on screen IS the final
        // state, so the run can close on the boot it already recorded.
        metrics.releaseRun();
        return;
      }
      setLiveParams(prev => ({
        ...prev, // the link's config wins (it may carry post-generation tweaks)
        dynamicAssetUrls: true,
        gameId: id,
        preloadedImages: cached.preloadedImages,
        assetMeta: cached.assetMeta
      }));
      setGameKey(k => k + 1);
      // Released after the remount is queued: the record now closes on the
      // boot that shows the real art, not the theme-art placeholder.
      metrics.releaseRun();
    }).catch(() => metrics.releaseRun());
    return () => { stale = true; };
  }, [initialConfig]);

  // While a generated game is running, keep the share payload in the URL so F5
  // restores the exact game (art via the local cache) and any copied URL is a
  // working share link. Keyed on gameKey/hasStarted — NOT liveParams — so
  // slider drags don't churn the address bar.
  useEffect(() => {
    if (!hasStarted) return;
    try {
      // Config-only hashes (no gameId) are valid too — they restore the same
      // static-art game on F5, and never leave a STALE previous game in the URL.
      window.history.replaceState(null, '', '#config=' + encodeShareConfig(liveParams));
    } catch { /* URL/history quirks must never break the game */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameKey, hasStarted]);

  // Persist environment variables to localStorage on startup to prevent cached/stale build variables
  useEffect(() => {
    const geminiEnv = import.meta.env.VITE_GEMINI_API_KEY;
    if (geminiEnv) {
      localStorage.setItem('GEMINI_API_KEY', geminiEnv);
    }
    // Dev/ops console tool: bulk cache population (see assetCache/bulkRunner.js).
    // Lazy import keeps the runner + prompt list out of the hot path.
    window.__PM_BULK = (list, opts) =>
      import('./game/assetCache/bulkRunner.js').then((m) => m.runBulkPopulation(list, opts));
  }, []);

  // Detect touch device or narrow screen layout dynamically for mobile virtual D-pad
  useEffect(() => {
    const checkLayout = () => {
      setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0 || window.innerWidth <= 1024);
    };
    checkLayout();
    window.addEventListener('resize', checkLayout);
    return () => window.removeEventListener('resize', checkLayout);
  }, []);

  // Global capture-phase keyboard event interceptor.
  // Stops keyboard event propagation if the target is an HTML input or textarea.
  // This guarantees Phaser never captures key events (preventing defaults) while typing.
  useEffect(() => {
    const handleCaptureKeyboard = (e) => {
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        e.stopPropagation();
      }
    };
    
    window.addEventListener('keydown', handleCaptureKeyboard, true);
    window.addEventListener('keyup', handleCaptureKeyboard, true);
    window.addEventListener('keypress', handleCaptureKeyboard, true);
    
    return () => {
      window.removeEventListener('keydown', handleCaptureKeyboard, true);
      window.removeEventListener('keyup', handleCaptureKeyboard, true);
      window.removeEventListener('keypress', handleCaptureKeyboard, true);
    };
  }, []);

  // Capture mode: one class on <body> drives every "hide this" rule in the CSS,
  // so no component needs to know the mode exists. Esc always gets you out —
  // browsers also fire it to leave fullscreen, which is the same intent.
  useEffect(() => {
    const body = document.body;
    body.classList.toggle('pm-capture', !!captureMode);
    body.classList.toggle('pm-capture--clean', captureMode === 'clean');
    if (!captureMode) return undefined;

    const onKey = (e) => {
      if (e.key === 'Escape') exitCaptureMode();
    };
    // Fullscreen cannot be requested without a user gesture, so arm the first
    // tap/click to enter it. Once only — after that the page is already clean.
    const onFirstGesture = () => {
      if (!fullscreenElement() && fullscreenContainerRef.current) {
        requestFullscreenOn(fullscreenContainerRef.current);
      }
      window.removeEventListener('pointerdown', onFirstGesture);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onFirstGesture);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onFirstGesture);
    };
  }, [captureMode]);

  // Fullscreen API detection & listener
  useEffect(() => {
    const isSupported = document.fullscreenEnabled || 
                       document.webkitFullscreenEnabled || 
                       document.mozFullScreenEnabled || 
                       document.msFullscreenEnabled;
    setIsFullscreenSupported(!!isSupported);

    const onFullscreenChange = () => {
      setIsFullscreen(!!fullscreenElement());
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  // Score listener from Phaser
  useEffect(() => {
    const handleScoreUpdate = (e) => setScore(e.detail);
    window.addEventListener('update-score', handleScoreUpdate);
    return () => window.removeEventListener('update-score', handleScoreUpdate);
  }, []);

  // Pause game when CreatorPanel menu is open
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('toggle-pause-game', { detail: { isPaused: isMenuOpen } }));
  }, [isMenuOpen]);

  // Score listener from Phaser
  useEffect(() => {
    const handleGameOver = (e) => {
      setGameOverData(e.detail);
      setIsGameOver(true);
    };
    const handleGameReset = () => {
      setIsGameOver(false);
      setGameOverData(null);
    };
    window.addEventListener('game-over', handleGameOver);
    window.addEventListener('game-reset', handleGameReset);
    return () => {
      window.removeEventListener('game-over', handleGameOver);
      window.removeEventListener('game-reset', handleGameReset);
    };
  }, []);

  const handleRestartGame = () => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    setIsGameOver(false);
    window.dispatchEvent(new CustomEvent('restart-game'));
  };

  const handleTweakSettings = () => {
    setIsGameOver(false);
    setIsMenuOpen(true);
  };

  // Sync live params to Phaser via global + CustomEvent
  if (typeof window !== 'undefined') {
    window.__GAME_LIVE_CONFIG = liveParams;
  }

  // (Removed 2026-08-20) An effect here used to mirror the --pm-safe-area-*
  // CSS vars onto window.__pmSafeArea{Top,Right,Bottom,Left}. Nothing ever read
  // them. The real need — telling the game layer how much screen the touch
  // controls occupy — is now served by src/game/uiZones.js, which MobileControls
  // populates from measured DOM rects.

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('update-game-config', { detail: liveParams }));
  }, [liveParams]);

  // --- Handlers ---

  const handleFullscreen = () => {
    if (fullscreenContainerRef.current && !fullscreenElement()) {
      requestFullscreenOn(fullscreenContainerRef.current);
    }
  };

  const handleExitFullscreen = () => {
    exitFullscreenNow();
  };

  // Leaving capture mode: drop the flag AND the URL param, so a reload does not
  // silently drop the user back into a chrome-free screen with no way out.
  const exitCaptureMode = () => {
    setCaptureMode(null);
    exitFullscreenNow();
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('capture');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* URL quirks must never trap the user in capture mode */
    }
  };

  const handleSliderChange = (e) => {
    const { name, value } = e.target;
    setLiveParams(prev => ({
      ...prev,
      [name]: parseFloat(value) || 0
    }));
  };

  const applyPreset = (key) => {
    const mode = key === 'action_quest' ? 'action_quest' : 'standard';
    const theme = 'ice';

    setPresetKey(key);
    setLiveParams({
      ...GAME_PRESETS[key],
      themeKey: theme,
      gameName: generateTitle("", mode, theme),
      dynamicAssetUrls: null // presets use built-in theme art
    });
  };

  const handleOpenSelector = () => {
    setIsSelectorOpen(true);
    setIsMenuOpen(false);
  };

  const handleGenerate = (key, customConfig) => {
    setPresetKey(key);
    setGameKey(k => k + 1);
    setLiveParams(customConfig);
    setHasStarted(true);
    setIsPromptOpen(false);
  };

  const handleOverlayGenerate = (key, customConfig) => {
    setPresetKey(key);
    setGameKey(k => k + 1);
    setLiveParams(customConfig);
    setIsPromptOpen(false);
  };

  const handleReopenPrompt = () => {
    setIsPromptOpen(true);
    setIsMenuOpen(false);
  };

  // Automatically blur active input element when the game starts, config updates, or game restarts
  // to ensure keyboard focus shifts back to the game/body.
  useEffect(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }, [hasStarted, presetKey, liveParams, isGameOver]);

  const handleGoHome = () => {
    setHasStarted(false);
    setIsMenuOpen(false);
    setIsGameOver(false);
    setGameOverData(null);
    // Leaving the game: drop the share hash so a reload lands on ScreenZero.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch { /* non-fatal */ }
  };

  const handlePromptGenerate = async (promptText) => {
    console.log('[App.jsx] handlePromptGenerate triggered with prompt:', promptText);
    // Synchronously blur active elements immediately before closing menu / updating config
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const raw = promptText.trim();
    if (!raw) return;

    // Generation takes 15s–2min — surface it with the compiler overlay so the user
    // sees log/progress feedback instead of a silently frozen panel.
    const pushProgress = (logText, progressVal) => {
      // Pipeline liveness ticks carry a pct with null text — keep the pct, skip the log
      setRegenState(prev => prev && {
        ...prev,
        progress: progressVal != null ? Math.max(prev.progress, progressVal) : prev.progress,
        logs: logText ? [...prev.logs.slice(-9), logText] : prev.logs
      });
    };

    // A running game first goes through the AI editor: variable tweaks apply live
    // (no asset generation, no reboot) via the existing update-game-config channel;
    // restyles redraw ONLY the targeted slots and keep everything else.
    if (hasStarted) {
      const edit = await interpretEditPrompt(liveParams, raw);
      console.log('[App.jsx] Edit interpretation:', edit);
      if (edit.intent === 'tweak') {
        if (!Object.keys(edit.changes).length) {
          return { applied: false, summary: edit.summary || 'No recognized changes — try rephrasing or describe a new game.' };
        }
        setLiveParams(prev => ({ ...prev, ...edit.changes }));
        setPresetKey('custom');
        return { applied: true, summary: edit.summary };
      }
      // Cherry-pick regeneration: only possible when we still hold the previous
      // run's preloaded images (preset/share-link games only have raw URLs — those
      // fall through to the full pipeline so every slot exists afterwards).
      if (edit.intent === 'restyle' && liveParams.preloadedImages) {
        const slots = resolveAssetTargets(edit.assetTargets, liveParams);
        if (!slots.length) {
          return { applied: false, summary: 'Nothing to redraw for this game mode — try naming another element.' };
        }
        setIsMenuOpen(false);
        setRegenState({
          title: 'Updating Artwork',
          progress: 5,
          logs: [`[EDITOR] ${edit.summary || `Redrawing ${edit.assetTargets.join(', ')}`} (${slots.length} slot${slots.length > 1 ? 's' : ''})...`]
        });
        try {
          const restyleT0 = performance.now();
          metrics.beginRun('restyle', { tier: 'restyle', gameId: liveParams.gameId || null, slots });
          const { preloadedImages: newImages, meta: newMeta, cost: restyleCost } = await regenerateAssetSlots({
            config: liveParams,
            instruction: raw,
            slots,
            onProgress: (logText, progressVal) => pushProgress(logText, progressVal)
          });
          metrics.mark('assets-generated');
          metrics.annotate({ estUsd: restyleCost?.estUsd || 0 });
          pushProgress('[ENGINE] Artwork updated! Restarting world...', 100);
          const keptOld = Object.entries(newMeta)
            .filter(([slot, m]) => m.dropped && liveParams.preloadedImages[slot])
            .map(([slot]) => slot);
          const mergedImages = { ...liveParams.preloadedImages };
          const mergedMeta = { ...(liveParams.assetMeta?.slots || {}) };
          const redrawnSlots = [];
          for (const [slot, m] of Object.entries(newMeta)) {
            if (m.dropped) {
              // New version failed the quality gates — keep the old art if we had it
              if (mergedImages[slot]) continue;
              mergedMeta[slot] = m;
              continue;
            }
            mergedImages[slot] = newImages[slot];
            mergedMeta[slot] = { ...m, source: 'generated' };
            redrawnSlots.push(slot);
          }
          const mergedParams = {
            ...liveParams,
            ...edit.changes,
            preloadedImages: mergedImages,
            assetMeta: {
              ...(liveParams.assetMeta || {}),
              slots: mergedMeta,
              // The report shows THIS restyle's spend, not the pre-restyle run's.
              cost: restyleCost || { estUsd: 0, imageCalls: 0, visionCalls: 0, calls: [] },
              run: {
                tier: 'restyle',
                elapsedMs: Math.round(performance.now() - restyleT0),
                generatedSlots: redrawnSlots,
                reusedSlots: Object.keys(mergedImages).filter(s => !redrawnSlots.includes(s)),
                estUsd: restyleCost?.estUsd || 0
              }
            }
          };
          setGameKey(k => k + 1);
          setPresetKey('custom');
          setLiveParams(mergedParams);
          // Persist the restyled art under the game's existing cache entry so a
          // later cache hit / share-link restore shows the restyled art.
          // Fire-and-forget: a cache failure must never affect the running game.
          updateGameArt(liveParams.gameId, {
            config: mergedParams,
            preloadedImages: mergedImages,
            assetMeta: mergedParams.assetMeta
          });
          const summary = keptOld.length
            ? `${edit.summary} — kept the previous ${keptOld.join(', ')} (new version failed quality checks)`
            : edit.summary;
          return { applied: true, summary };
        } catch (err) {
          console.error('[App.jsx] Restyle failed:', err);
          // No remount follows a failed restyle, so nothing would ever close this
          // run — drop it rather than let an unrelated later boot adopt it.
          metrics.cancelRun();
          return { applied: false, summary: err.message };
        } finally {
          setRegenState(null);
        }
      }
      // intent === 'regenerate' (or restyle with no retained images) → full pipeline below
    }

    setIsMenuOpen(false);
    setRegenState({ progress: 3, logs: [`[EDITOR] New world required for "${raw}" — regenerating...`] });
    metrics.beginRun('generate', { via: 'creator-panel', promptChars: raw.length });

    try {
      console.log('[App.jsx] Calling generateGameConfig...');
      const result = await generateGameConfig(raw, (logText, progressVal) => {
        console.log(`[App.jsx Config Progress] ${progressVal}% - ${logText}`);
        // Config is the fast local phase — cap it so asset progress (73+) takes over
        pushProgress(logText, Math.min(progressVal ?? 0, 70));
      });
      const updatedConfig = result.config;
      metrics.mark('config');
      metrics.annotate({ gameType: updatedConfig.gameType });

      const gen = await generateOrRestoreAssets({
        config: updatedConfig,
        userPrompt: raw,
        promptKey: makePromptKey(raw, updatedConfig.gameType),
        onProgress: (logText, progressVal) => {
          console.log(`[App.jsx Asset Progress] ${progressVal}% - ${logText}`);
          pushProgress(logText, progressVal);
        }
      });

      pushProgress('[ENGINE] World gate synchronized! Starting game...', 100);

      // Apply — force fresh Phaser instance
      setGameKey(k => k + 1);
      setPresetKey('custom');
      setLiveParams({ ...gen.config, preloadedImages: gen.preloadedImages, assetMeta: gen.assetMeta });
    } catch (err) {
      console.error('[App.jsx] Prompt generation failed:', err);
      metrics.cancelRun(); // no boot follows a failed regeneration
      const message = err.cacheOnlyMiss
        ? 'Cache only is ON and nothing cached matches this prompt. Turn the toggle off on the generator screen (top right) to create new art.'
        : err.message;
      window.dispatchEvent(new CustomEvent('playmint-error', { detail: { message } }));
      throw err;
    } finally {
      setRegenState(null);
    }
  };

  return (
    <div ref={fullscreenContainerRef} style={{ position: 'relative', width: '100%', height: '100dvh', overflow: 'hidden' }}>

      {/* In-place world regeneration progress (Creator Panel prompt) */}
      <RegenOverlay state={regenState} />

      {/* Game view rendered if started OR if transitioning */}
      {(hasStarted || isTransitioning) && (
        <>
          {/* Main Game Container - Rendered at zIndex: 0 */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 0, overflow: 'hidden' }}>
            <div style={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
              <GameComponent key={gameKey} isFullscreen={isFullscreen} />
            </div>
          </div>

          {/* Premium UI Overlay Layer - Rendered at zIndex: 1 */}
          <div style={{
            position: 'absolute',
            inset: 0,
            height: '100%',
            width: '100%',
            opacity: 1,
            zIndex: 1,
            pointerEvents: 'none'
          }}>
            <HudHeader
              liveParams={liveParams}
              score={score}
              isFullscreen={isFullscreen}
              isFullscreenSupported={isFullscreenSupported}
              onFullscreen={handleFullscreen}
              onExitFullscreen={handleExitFullscreen}
              onMenuOpen={() => setIsMenuOpen(true)}
              onLogoClick={handleReopenPrompt}
            />

            {captureMode && (
              <button
                className="pm-capture-exit"
                onClick={exitCaptureMode}
                title="Leave capture mode (Esc)"
                aria-label="Leave capture mode"
              >
                ✕ exit capture
              </button>
            )}

            <CreatorPanel
              isOpen={isMenuOpen}
              onClose={() => {
                if (document.activeElement && typeof document.activeElement.blur === 'function') {
                  document.activeElement.blur();
                }
                setIsMenuOpen(false);
              }}
              onOpenSelector={handleOpenSelector}
              liveParams={liveParams}
              setLiveParams={setLiveParams}
              presetKey={presetKey}
              setPresetKey={setPresetKey}
              onSliderChange={handleSliderChange}
              onPromptGenerate={handlePromptGenerate}
              onHomeClick={handleGoHome}
            />

            {/* Premium Virtual Mobile Controls Overlay */}
            {isTouchDevice && hasStarted && !isGameOver && (
              <MobileControls
                gameType={liveParams.gameType}
                themeKey={liveParams.themeKey}
                projectilesEnabled={!!liveParams.actionProjectileEnabled}
              />
            )}

            {!isTouchDevice && liveParams.gameType === 'runner' && (
              <div className="pm-keyboard-hint" style={{ position: 'fixed', bottom: '30px', width: '100%', textAlign: 'center', zIndex: 10, pointerEvents: 'none' }}>
                <p style={{ margin: 0, color: 'var(--pm-text-secondary)', fontSize: '14px', background: 'var(--pm-bg-panel)', padding: '8px 16px', display: 'inline-block', borderRadius: '20px', border: '1px solid var(--pm-border)', boxShadow: 'var(--pm-shadow-panel)' }}>
                  Press <span style={{ background: 'var(--pm-bg-input)', padding: '2px 8px', borderRadius: '4px', color: 'var(--pm-accent-teal)', fontFamily: 'monospace', fontWeight: 'bold' }}>SPACE</span> to jump
                </p>
              </div>
            )}

            {!isTouchDevice && liveParams.gameType === 'platformer' && (
              <div className="pm-keyboard-hint" style={{ position: 'fixed', bottom: '30px', width: '100%', textAlign: 'center', zIndex: 10, pointerEvents: 'none' }}>
                <p style={{ margin: 0, color: 'var(--pm-text-secondary)', fontSize: '14px', background: 'var(--pm-bg-panel)', padding: '8px 16px', display: 'inline-block', borderRadius: '20px', border: '1px solid var(--pm-border)', boxShadow: 'var(--pm-shadow-panel)' }}>
                  <span style={{ background: 'var(--pm-bg-input)', padding: '2px 8px', borderRadius: '4px', color: 'var(--pm-accent-teal)', fontFamily: 'monospace', fontWeight: 'bold' }}>WASD / Arrows</span> Move · <span style={{ background: 'var(--pm-bg-input)', padding: '2px 8px', borderRadius: '4px', color: 'var(--pm-accent-teal)', fontFamily: 'monospace', fontWeight: 'bold' }}>SPACE</span> Jump · <span style={{ background: 'var(--pm-bg-input)', padding: '2px 8px', borderRadius: '4px', color: 'var(--pm-accent-purple)', fontFamily: 'monospace', fontWeight: 'bold' }}>E</span> Melee{liveParams.actionProjectileEnabled ? <> · <span style={{ background: 'var(--pm-bg-input)', padding: '2px 8px', borderRadius: '4px', color: 'var(--pm-accent-orange)', fontFamily: 'monospace', fontWeight: 'bold' }}>F</span> Shoot</> : ''}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* Overlays rendered directly in App to avoid mobile Safari pointer-events and rotation clipping bugs */}
      {isGameOver && gameOverData && (
        <GameOverOverlay
          isWin={gameOverData.isWin}
          score={gameOverData.score}
          themeKey={gameOverData.themeKey}
          gameType={gameOverData.gameType}
          onRestart={handleRestartGame}
          onTweakSettings={handleTweakSettings}
        />
      )}
      <GameSelectorModal
        isOpen={isSelectorOpen}
        presetKey={presetKey}
        onSelectPreset={applyPreset}
        onClose={() => {
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          setIsSelectorOpen(false);
        }}
      />

      {/* ScreenZero rendered if NOT started */}
      {!hasStarted && (
        <ScreenZero
          onStartTransition={(config) => {
            setGameKey(k => k + 1);
            setIsTransitioning(true);
            setLiveParams(config);
          }}
          onCompleteTransition={() => {
            setHasStarted(true);
            setIsTransitioning(false);
          }}
          isTransitioning={isTransitioning}
        />
      )}

      {isPromptOpen && (
        <ScreenZero
          onGenerate={handleOverlayGenerate}
          onClose={() => setIsPromptOpen(false)}
          isOverlay
          currentConfig={liveParams}
        />
      )}

      {activeError && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          zIndex: 99999, backdropFilter: 'blur(12px)',
          pointerEvents: 'auto'
        }}>
          <div style={{
            background: 'var(--pm-bg-dark, #060a10)',
            border: '2px solid #ff453a',
            borderRadius: '16px',
            padding: '24px',
            width: '90%',
            maxWidth: '500px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5), 0 0 30px rgba(255, 69, 58, 0.15)',
            textAlign: 'left',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '24px' }}>⚠️</span>
              <h3 style={{ margin: 0, color: '#ff453a', fontFamily: 'var(--font-heading, sans-serif)', fontSize: '18px', fontWeight: '800', letterSpacing: '0.5px' }}>
                RUNTIME ERROR DETECTED
              </h3>
            </div>
            
            <p style={{ margin: 0, color: 'var(--pm-text-secondary, #8e9cae)', fontSize: '13px', lineHeight: '1.4' }}>
              An error occurred during world compilation or asset loading. You can copy the diagnostic details below to share:
            </p>

            <div style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
              padding: '14px',
              maxHeight: '180px',
              overflowY: 'auto',
              fontFamily: 'monospace',
              fontSize: '12px',
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              color: '#ff453a'
            }}>
              {activeError}
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(activeError);
                  alert('Error details copied to clipboard!');
                }}
                style={{
                  flex: 1,
                  background: '#ff453a',
                  border: 'none',
                  color: '#fff',
                  padding: '10px 16px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '14px',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.target.style.background = '#ff3b30'}
                onMouseLeave={(e) => e.target.style.background = '#ff453a'}
              >
                Copy Details
              </button>
              
              <button
                onClick={() => setActiveError(null)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#fff',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontWeight: '600',
                  fontSize: '14px',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.15)'}
                onMouseLeave={(e) => e.target.style.background = 'rgba(255,255,255,0.08)'}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
