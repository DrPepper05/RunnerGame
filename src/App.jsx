import React, { useState, useRef, useEffect } from 'react';
import GameComponent from './GameComponent';
import GameSelectorModal from './components/GameSelectorModal';
import HudHeader from './components/HudHeader';
import CreatorPanel from './components/CreatorPanel';
import ScreenZero from './components/ScreenZero';
import { GAME_PRESETS } from './gameConfig';
import { generateGameConfig } from './game/geminiService';
import { generateGameAssets, regenerateAssetSlots, compileFallbackUrls } from './game/assetPipeline';
import { generateTitle } from './game/promptUtils';
import { interpretEditPrompt, resolveAssetTargets } from './game/gameEditor';
import GameOverOverlay from './components/GameOverOverlay';
import RegenOverlay from './components/RegenOverlay';
import MobileControls from './components/MobileControls';

const getInitialState = () => {
  if (typeof window !== 'undefined') {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#config=')) {
      try {
        const encodedConfig = hash.replace('#config=', '');
        const decodedConfigString = atob(encodedConfig);
        const importedConfig = JSON.parse(decodedConfigString);
        if (typeof importedConfig === 'object' && importedConfig !== null && Object.keys(importedConfig).length > 0) {
          if (!importedConfig.gameName) importedConfig.gameName = 'PlayMint Core';
          if (!importedConfig.dynamicAssetUrls) {
            importedConfig.dynamicAssetUrls = compileFallbackUrls(importedConfig);
          }
          return { presetKey: 'custom', liveParams: importedConfig, isImported: true };
        }
      } catch (error) {
        console.error('Failed to parse config from URL:', error);
      }
    }
  }

  const initialPreset = { ...GAME_PRESETS['standard'], gameName: 'PlayMint Core' };
  initialPreset.dynamicAssetUrls = compileFallbackUrls(initialPreset);

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

  // Persist environment variables to localStorage on startup to prevent cached/stale build variables
  useEffect(() => {
    const geminiEnv = import.meta.env.VITE_GEMINI_API_KEY;
    if (geminiEnv) {
      localStorage.setItem('GEMINI_API_KEY', geminiEnv);
    }
    const polliEnv = import.meta.env.VITE_POLLINATIONS_API_KEY;
    if (polliEnv) {
      localStorage.setItem('POLLINATIONS_API_KEY', polliEnv);
    }
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

  // Fullscreen API detection & listener
  useEffect(() => {
    const isSupported = document.fullscreenEnabled || 
                       document.webkitFullscreenEnabled || 
                       document.mozFullScreenEnabled || 
                       document.msFullscreenEnabled;
    setIsFullscreenSupported(!!isSupported);

    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    const computeInsets = () => {
      const styles = getComputedStyle(root);
      const bottom = parseFloat(styles.getPropertyValue('--pm-safe-area-bottom')) || 0;
      const left = parseFloat(styles.getPropertyValue('--pm-safe-area-left')) || 0;
      const right = parseFloat(styles.getPropertyValue('--pm-safe-area-right')) || 0;
      const top = parseFloat(styles.getPropertyValue('--pm-safe-area-top')) || 0;
      window.__pmSafeAreaBottom = bottom;
      window.__pmSafeAreaLeft = left;
      window.__pmSafeAreaRight = right;
      window.__pmSafeAreaTop = top;
    };
    computeInsets();
    window.addEventListener('resize', computeInsets);
    window.addEventListener('orientationchange', computeInsets);
    return () => {
      window.removeEventListener('resize', computeInsets);
      window.removeEventListener('orientationchange', computeInsets);
    };
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('update-game-config', { detail: liveParams }));
  }, [liveParams]);

  // --- Handlers ---

  const handleFullscreen = () => {
    if (fullscreenContainerRef.current && !document.fullscreenElement) {
      if (fullscreenContainerRef.current.requestFullscreen) {
        fullscreenContainerRef.current.requestFullscreen().catch(err => {
          console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
      }
    }
  };

  const handleExitFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
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
    const resolvedMode = key === 'action_quest' ? 'platformer' : 'runner';

    setPresetKey(key);
    setLiveParams({
      ...GAME_PRESETS[key],
      themeKey: theme,
      gameName: generateTitle("", mode, theme),
      dynamicAssetUrls: compileFallbackUrls({ ...GAME_PRESETS[key], themeKey: theme, gameType: resolvedMode })
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
          const { preloadedImages: newImages, meta: newMeta } = await regenerateAssetSlots({
            config: liveParams,
            instruction: raw,
            slots,
            onProgress: (logText, progressVal) => pushProgress(logText, progressVal)
          });
          pushProgress('[ENGINE] Artwork updated! Restarting world...', 100);
          const keptOld = Object.entries(newMeta)
            .filter(([slot, m]) => m.dropped && liveParams.preloadedImages[slot])
            .map(([slot]) => slot);
          setGameKey(k => k + 1);
          setPresetKey('custom');
          setLiveParams(prev => {
            const mergedImages = { ...prev.preloadedImages };
            const mergedMeta = { ...(prev.assetMeta?.slots || {}) };
            for (const [slot, m] of Object.entries(newMeta)) {
              if (m.dropped) {
                // New version failed the quality gates — keep the old art if we had it
                if (mergedImages[slot]) continue;
                mergedMeta[slot] = m;
                continue;
              }
              mergedImages[slot] = newImages[slot];
              mergedMeta[slot] = m;
            }
            return {
              ...prev,
              ...edit.changes,
              preloadedImages: mergedImages,
              assetMeta: { ...(prev.assetMeta || {}), slots: mergedMeta }
            };
          });
          const summary = keptOld.length
            ? `${edit.summary} — kept the previous ${keptOld.join(', ')} (new version failed quality checks)`
            : edit.summary;
          return { applied: true, summary };
        } catch (err) {
          console.error('[App.jsx] Restyle failed:', err);
          return { applied: false, summary: err.message };
        } finally {
          setRegenState(null);
        }
      }
      // intent === 'regenerate' (or restyle with no retained images) → full pipeline below
    }

    setIsMenuOpen(false);
    setRegenState({ progress: 3, logs: [`[EDITOR] New world required for "${raw}" — regenerating...`] });

    try {
      console.log('[App.jsx] Calling generateGameConfig...');
      const result = await generateGameConfig(raw, (logText, progressVal) => {
        console.log(`[App.jsx Config Progress] ${progressVal}% - ${logText}`);
        // Config is the fast local phase — cap it so asset progress (73+) takes over
        pushProgress(logText, Math.min(progressVal ?? 0, 70));
      });
      const updatedConfig = result.config;

      const { preloadedImages, assetMeta } = await generateGameAssets({
        config: updatedConfig,
        userPrompt: raw,
        onProgress: (logText, progressVal) => {
          console.log(`[App.jsx Asset Progress] ${progressVal}% - ${logText}`);
          pushProgress(logText, progressVal);
        }
      });

      pushProgress('[ENGINE] World gate synchronized! Starting game...', 100);

      // Apply — force fresh Phaser instance
      setGameKey(k => k + 1);
      setPresetKey('custom');
      setLiveParams({ ...updatedConfig, preloadedImages, assetMeta });
    } catch (err) {
      console.error('[App.jsx] Prompt generation failed:', err);
      window.dispatchEvent(new CustomEvent('playmint-error', { detail: { message: err.message } }));
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
              <div style={{ position: 'fixed', bottom: '30px', width: '100%', textAlign: 'center', zIndex: 10, pointerEvents: 'none' }}>
                <p style={{ margin: 0, color: 'var(--pm-text-secondary)', fontSize: '14px', background: 'var(--pm-bg-panel)', padding: '8px 16px', display: 'inline-block', borderRadius: '20px', border: '1px solid var(--pm-border)', boxShadow: 'var(--pm-shadow-panel)' }}>
                  Press <span style={{ background: 'var(--pm-bg-input)', padding: '2px 8px', borderRadius: '4px', color: 'var(--pm-accent-teal)', fontFamily: 'monospace', fontWeight: 'bold' }}>SPACE</span> to jump
                </p>
              </div>
            )}

            {!isTouchDevice && liveParams.gameType === 'platformer' && (
              <div style={{ position: 'fixed', bottom: '30px', width: '100%', textAlign: 'center', zIndex: 10, pointerEvents: 'none' }}>
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
