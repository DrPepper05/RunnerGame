import React, { useState, useRef, useEffect } from 'react';
import { GAME_PRESETS } from '../gameConfig';
import { generateTitle } from '../game/promptUtils';
import { generateGameConfig } from '../game/geminiService';
import { isGeminiConfigured, createCancelToken } from '../game/assetPipeline';
import { generateOrRestoreAssets, makePromptKey, makePresetKey } from '../game/assetCache';
import * as metrics from '../game/metrics';
import { THEMES } from '../game/themes';

const BANNED_WORDS = ['fuck', 'shit', 'bitch', 'cunt', 'ass', 'dick', 'pussy', 'cock', 'nigger', 'faggot'];

const AVAILABLE_MODES = [
  { key: 'standard', label: 'Runner', desc: 'Fast-paced infinite progression runner. Avoid obstacles, collect coins.' },
  { key: 'action_quest', label: 'Action Quest', desc: 'Classic 2D platformer with melee slashing, projectile combat, and patrolling enemies.' },
];

const COMING_SOON_MODES = [
  { key: 'rpg', label: 'RPG Adventure', desc: 'Grid pathfinding, loot chests, turn-based dialogue, and epic fantasy upgrades.' },
  { key: 'empire', label: 'Empire Builder', desc: 'Construct towers, gather crystals, and build your pixel galactic civilization.' },
  { key: 'fighting', label: 'Fighting Arena', desc: 'Snappy retro dueling. Deliver perfect parries, sword sweeps, and final hits.' },
  { key: 'racing', label: 'Racing Rush', desc: 'Speed through scrolling highways, drift around turns, and top the leaderboards.' },
  { key: 'shooter', label: 'Shooter Arena', desc: 'Dodge bullet hell waves, fire plasma bursts, and survive boss arenas.' },
  { key: 'survival', label: 'Survival Mode', desc: 'Scavenge supplies in dark woods, build campfires, and outlast the night waves.' },
  { key: 'simulator', label: 'Simulator World', desc: 'Design, manage, and optimize complex simulated environments and ecosystems.' }
];

const HAS_ENV_GEMINI_KEY = !!import.meta.env.VITE_GEMINI_API_KEY;

const API_KEY_TICK_STYLE = {
  background: 'rgba(0, 229, 153, 0.15)',
  border: '1px solid var(--pm-accent-teal)',
  color: 'var(--pm-accent-teal)',
  fontSize: '14px',
  fontWeight: 700,
  width: '32px',
  height: '32px',
  borderRadius: '8px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backdropFilter: 'blur(8px)',
  padding: 0
};

const getRandomMode = (selectedMode) => {
  return selectedMode || (Math.random() > 0.5 ? 'action_quest' : 'standard');
};

const getRandomDifficulty = () => {
  return Math.floor(Math.random() * 10) + 1;
};

const WORLDS = [
  {
    name: 'Ice World',
    filter: 'none',
    layers: [
      '/assets/themes/winter/bg-1.png',
      '/assets/themes/winter/bg-2.png',
      '/assets/themes/winter/bg-3.png'
    ]
  },
  {
    name: 'Lava World',
    filter: 'none',
    layers: [
      '/assets/themes/lava/sky.png',
      '/assets/themes/lava/bg.png',
      '/assets/themes/lava/mountains.png',
      '/assets/themes/lava/clouds.png'
    ]
  },
  {
    name: 'Forest World',
    filter: 'none',
    layers: [
      '/assets/themes/forest/bg_far.png',
      '/assets/themes/forest/bg_mid.png'
    ]
  },
  {
    name: 'Space World',
    filter: 'none',
    layers: [
      '/assets/themes/space/bg_stars.png',
      '/assets/themes/space/bg_nebula.png',
      '/assets/themes/space/bg_planet.png'
    ]
  },
  {
    name: 'City World',
    filter: 'none',
    layers: [
      '/assets/themes/city/bg_far.png',
      '/assets/themes/city/bg_mid.png',
      '/assets/themes/city/bg_near.png'
    ]
  },
  {
    name: 'Future RPG World',
    filter: 'hue-rotate(70deg) saturate(1.4) brightness(0.9)',
    layers: [
      '/assets/themes/forest/bg_far.png',
      '/assets/themes/forest/bg_mid.png'
    ]
  },
  {
    name: 'Future Shooter World',
    filter: 'hue-rotate(285deg) saturate(1.5) brightness(0.9)',
    layers: [
      '/assets/themes/space/bg_stars.png',
      '/assets/themes/space/bg_nebula.png',
      '/assets/themes/space/bg_planet.png'
    ]
  },
  {
    name: 'Future Racing World',
    filter: 'hue-rotate(190deg) saturate(1.4) contrast(1.1) brightness(0.85)',
    layers: [
      '/assets/themes/city/bg_far.png',
      '/assets/themes/city/bg_mid.png',
      '/assets/themes/city/bg_near.png'
    ]
  }
];

const ScreenZero = ({ onGenerate, onClose, isOverlay, onStartTransition, onCompleteTransition, currentConfig }) => {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [transitionPhase, setTransitionPhase] = useState('idle'); // idle | compiling | fading | done
  const [selectedMode, setSelectedMode] = useState(null); // null | 'standard' | 'action_quest'
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [toastMessage, setToastMessage] = useState('');
  const [currentWorldIndex, setCurrentWorldIndex] = useState(0);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('GEMINI_API_KEY') || '');
  // "Cache only" (persisted): hard no-image-spend mode — the cache ladder reuses
  // matched art or boots built-in theme art, never generating images. The asset
  // cache reads PM_FORCE_CACHE itself at run start; this state only drives the UI.
  const [cacheOnly, setCacheOnly] = useState(() => {
    try { return localStorage.getItem('PM_FORCE_CACHE') === '1'; } catch { return false; }
  });
  const toggleCacheOnly = () => {
    setCacheOnly((prev) => {
      const next = !prev;
      try {
        if (next) localStorage.setItem('PM_FORCE_CACHE', '1');
        else localStorage.removeItem('PM_FORCE_CACHE');
      } catch { /* private mode — session-only toggle */ }
      return next;
    });
  };
  const [keyInput, setKeyInput] = useState('');
  const [isEditingKey, setIsEditingKey] = useState(false);
  const formRef = useRef(null);
  const [phaserLoaded, setPhaserLoaded] = useState(false);
  // Cancellation for the in-flight generation run. Every new run cancels the
  // previous one, and unmounting (✕ Close, successful boot, logo re-open cycle)
  // cancels whatever is still running — this is what makes the Generate button
  // work again after abandoning a run instead of requiring a page refresh.
  const runTokenRef = useRef(null);
  const beginRun = () => {
    runTokenRef.current?.cancel();
    runTokenRef.current = createCancelToken();
    return runTokenRef.current;
  };
  useEffect(() => () => { runTokenRef.current?.cancel(); }, []);

  useEffect(() => {
    const handleFileComplete = (e) => {
      const key = e.detail?.key;
      setTerminalLogs(prev => [...prev, `[Asset Loader] Loaded asset texture: ${key}...`]);
    };
    const handleLoadComplete = () => {
      setTerminalLogs(prev => [...prev, `[ENGINE] WebGL dynamic textures bound successfully.`]);
      setPhaserLoaded(true);
    };
    
    window.addEventListener('phaser-file-complete', handleFileComplete);
    window.addEventListener('phaser-load-complete', handleLoadComplete);
    
    return () => {
      window.removeEventListener('phaser-file-complete', handleFileComplete);
      window.removeEventListener('phaser-load-complete', handleLoadComplete);
    };
  }, []);

  // Two separate timers, one per phase step. They must NOT live in a single effect
  // run: with transitionPhase as a dependency, the 'compiling'→'fading' state change
  // re-runs the effect and its cleanup would cancel the pending "done" timer — leaving
  // this full-screen container mounted invisibly over the game, swallowing every click.
  useEffect(() => {
    // Overlay mode drives its own phases in processPrompt/startCompilationSequence:
    // a phaser-load-complete fired by the game running UNDERNEATH (e.g. a restart)
    // must not push the overlay to 'done' mid-generation — 'done' sets
    // pointerEvents:none and would silently swallow the Close button.
    if (isOverlay) return;
    if (phaserLoaded && transitionPhase === 'compiling') {
      setProgress(100);
      setTerminalLogs(prev => [...prev, '[ENGINE] World gate synchronized! Starting game...']);

      const fadeTimer = setTimeout(() => {
        setTransitionPhase('fading');
      }, 1000);
      return () => clearTimeout(fadeTimer);
    }
    if (transitionPhase === 'fading') {
      const doneTimer = setTimeout(() => {
        setTransitionPhase('done');
        if (onCompleteTransition) onCompleteTransition();
      }, 1000);
      return () => clearTimeout(doneTimer);
    }
  }, [phaserLoaded, transitionPhase]);

  useEffect(() => {
    if (transitionPhase !== 'idle') return;
    const timer = setInterval(() => {
      setCurrentWorldIndex(prev => (prev + 1) % WORLDS.length);
    }, 8000);
    return () => clearInterval(timer);
  }, [transitionPhase]);

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const getBackgroundStyle = (baseOpacity, depthScale, assetUrl) => {
    let scale = 1.0;
    let filter = 'none';
    let opacity = baseOpacity;
    let animation = 'none';

    if (transitionPhase === 'idle') {
      if (depthScale === 1) animation = 'parallaxFar 24s ease-in-out infinite alternate';
      else if (depthScale === 2) animation = 'parallaxMid 16s ease-in-out infinite alternate';
      else animation = 'parallaxNear 10s ease-in-out infinite alternate';
    } else if (transitionPhase === 'compiling') {
      scale = 1.15 + (depthScale * 0.05); // dynamic subtle depth scale zoom
      filter = 'blur(4px) saturate(1.2)';
    } else if (transitionPhase === 'fading') {
      scale = 1.45;
      filter = 'blur(12px) saturate(1.5)';
      opacity = 0;
    }

    return {
      position: 'fixed', inset: 0, zIndex: 0,
      backgroundImage: `url(${assetUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center 30%',
      imageRendering: 'pixelated',
      opacity,
      transform: transitionPhase === 'idle' ? 'none' : `scale(${scale})`,
      filter,
      animation,
      transition: 'all 2.0s cubic-bezier(0.25, 1, 0.5, 1)',
      pointerEvents: 'none'
    };
  };

  const handleGenerate = (e) => {
    if (e) e.preventDefault();
    // processPrompt handles its own failures; this catch is a backstop so an
    // unexpected throw can never strand the button in its disabled state.
    processPrompt(prompt).catch(console.error);
  };

  const handleQuickStart = () => {
    generateRandom("Quick start! Generated a default preset.");
  };

  const handleExampleClick = (exampleText) => {
    setPrompt(exampleText);
    processPrompt(exampleText);
  };

  // Terminal pipeline failure never dead-ends the flow: boot the game on built-in
  // theme art instead (dynamicAssetUrls null routes every texture pick to the
  // static theme set). Custom prompts have themeKey null — pick 'ice' (the
  // generateRandom precedent, full multi-layer art).
  const toStaticThemeConfig = (config) => ({
    ...config,
    themeKey: THEMES[config.themeKey] ? config.themeKey : 'ice',
    dynamicAssetUrls: null,
    preloadedImages: null,
    assetMeta: null
  });

  // Shared asset-phase progress handler: pipeline liveness ticks carry a pct with
  // null text (skip the log), and the bar must never move backwards mid-compile
  // (the pipeline's design-step report of 73 lands after the UI already showed 75).
  const assetProgressHandler = (logText, progressVal) => {
    if (logText) setTerminalLogs(prev => [...prev, logText]);
    if (progressVal != null) setProgress(p => Math.max(p, progressVal));
  };

  // Preset cache hits reuse ART only: the freshly rolled preset config (new
  // difficulty every run) keeps its values; the cached run contributes the game
  // id and the dyn_* routing flag. Fresh runs boot the wrapper's stamped config.
  const presetBootConfig = (freshConfig, result) => result.fromCache
    ? { ...freshConfig, gameId: result.config.gameId, sourcePrompt: result.config.sourcePrompt, dynamicAssetUrls: true }
    : result.config;

  const startCompilationSequence = async (newConfig, promptText, cacheKey = null) => {
    if (isOverlay) {
      // Overlay runs show the same compiler terminal as the first-run flow
      // ('compiling' is the phase the progress UI actually renders — the old
      // 'expanding' phase rendered nothing, which read as "Generate does nothing").
      const token = beginRun();
      // The timing clock starts at the click, not inside the cache module: the
      // number the client quotes is what THEY wait, prompt parsing included.
      metrics.beginRun('generate', {
        via: 'overlay',
        gameType: newConfig.gameType,
        promptChars: (promptText || '').length
      });
      setIsGenerating(true);
      setTransitionPhase('compiling');
      setPhaserLoaded(false);
      setTerminalLogs([
        `[PROMPT] Input -> ${promptText ? `"${String(promptText).substring(0, 32)}"` : 'Quick Start Preset'}`,
        `[ASSETS] Starting asset generation via ${isGeminiConfigured() ? 'Gemini AI' : 'built-in theme artwork (no API key)'}...`
      ]);
      setProgress(10);
      try {
        const gen = await generateOrRestoreAssets({
          config: newConfig,
          promptKey: cacheKey,
          onProgress: assetProgressHandler,
          cancelToken: token
        });
        if (token.cancelled) {
          metrics.cancelRun();
          return; // stale run — the user moved on
        }
        metrics.mark('assets-ready');
        setTransitionPhase('done');
        onGenerate('custom', { ...presetBootConfig(newConfig, gen), preloadedImages: gen.preloadedImages, assetMeta: gen.assetMeta });
      } catch (err) {
        if (token.cancelled || err.cancelled) {
          metrics.cancelRun();
          return; // cancelled ≠ failed — no static boot
        }
        metrics.mark('assets-failed');
        console.error('[Compilation Error] Overlay generation failed, using static theme:', err);
        setTransitionPhase('done');
        onGenerate('custom', toStaticThemeConfig(newConfig));
      } finally {
        setIsGenerating(false); // the latch can never stick again
      }
      return;
    }

    metrics.beginRun('generate', {
      via: promptText ? 'prompt' : 'preset',
      gameType: newConfig.gameType,
      promptChars: (promptText || '').length
    });
    setIsGenerating(true);
    setTransitionPhase('compiling');
    setPhaserLoaded(false);
    // NOTE: no onStartTransition(newConfig) here — booting Phaser before assets
    // exist would render missing-texture boxes for textures the preloaded boot
    // replaces anyway. The single boot happens below with preloadedImages.

    const displayPrompt = promptText ? `"${promptText.substring(0, 32)}"` : "Quick Start Preset";
    const themeName = (newConfig.themeKey || 'default').toUpperCase();
    const modeName = newConfig.gameType === 'platformer' ? 'ACTION QUEST' : 'RUNNER';
    const difficulty = newConfig.difficulty || 5;

    const gravity = newConfig.gameType === 'platformer' 
      ? (newConfig.actionGravity || 1400) 
      : (newConfig.gravity || 1600);

    const speed = newConfig.gameType === 'platformer'
      ? `Jump: ${newConfig.actionJumpHeight || 550}px`
      : `Speed: ${newConfig.runSpeed || 400}px/s`;

    setTerminalLogs([
      "[SYSTEM] Booting PlayMint Generative Engine v2.0...",
      `[PROMPT] Input -> ${displayPrompt}`,
      `[THEME]  Mapping assets -> [${themeName} THEME, ${modeName}]`,
      `[PHYSIC] Gravity: ${gravity}m/s² · ${speed} · Diff: ${difficulty}/10`,
      "[ENGINE] Synchronizing WebGL canvas & establishing world gate...",
      `[ASSETS] Starting asset generation via ${isGeminiConfigured() ? 'Gemini AI' : 'built-in theme artwork (no API key)'}...`
    ]);
    setProgress(75);

    try {
      const gen = await generateOrRestoreAssets({
        config: newConfig,
        promptKey: cacheKey,
        onProgress: assetProgressHandler,
        cancelToken: beginRun() // defensive symmetry with the overlay paths
      });

      metrics.mark('assets-ready');
      setTerminalLogs(prev => [...prev, '[ENGINE] Booting game scene and registering WebGL textures...']);
      onStartTransition({ ...presetBootConfig(newConfig, gen), preloadedImages: gen.preloadedImages, assetMeta: gen.assetMeta });
    } catch (err) {
      metrics.mark('assets-failed');
      // Stay in the 'compiling' phase: the static boot fires phaser-load-complete,
      // which drives the normal 100% → fade sequence.
      console.error('[Compilation Error] Preset asset generation failed, using static theme:', err);
      if (!err.cacheOnlyMiss) { // cache-only miss already explained itself via onProgress
        setTerminalLogs(prev => [...prev, '[ASSETS] AI generation unavailable — launching with built-in theme artwork. Add a Gemini API key (top right) for AI assets.']);
      }
      onStartTransition(toStaticThemeConfig(newConfig));
    }
  };

  const processPrompt = async (input) => {
    const text = input.trim();
    if (!text) {
      generateRandom();
      return;
    }

    // Whole-word match only: a substring check silently rejected innocent prompts
    // ("brASS automaton", "cASSette", "coCOCKpit") and swapped in a random ice game
    const isUnsafe = BANNED_WORDS.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text));
    if (isUnsafe) {
      generateRandom();
      return;
    }

    if (isOverlay) {
      // Same restructure as the overlay Quick Start branch: visible 'compiling'
      // terminal, config generation INSIDE the try, stale-run guards, and a
      // finally that releases the isGenerating latch no matter what.
      const token = beginRun();
      metrics.beginRun('generate', { via: 'overlay-prompt', promptChars: text.length });
      setIsGenerating(true);
      setTransitionPhase('compiling');
      setPhaserLoaded(false);
      setTerminalLogs([
        `[PROMPT] Input -> "${text.substring(0, 32)}"`,
        `[ASSETS] Starting asset generation via ${isGeminiConfigured() ? 'Gemini AI' : 'built-in theme artwork (no API key)'}...`
      ]);
      setProgress(5);
      let overlayConfig = null;
      try {
        const result = await generateGameConfig(text, (logText, progressVal) => {
          setTerminalLogs(prev => [...prev, logText]);
          setProgress(p => Math.max(p, Math.min(progressVal, 70)));
        });
        overlayConfig = result.config;
        metrics.mark('config');
        metrics.annotate({ gameType: result.config.gameType });
        setProgress(75);
        const gen = await generateOrRestoreAssets({
          config: result.config,
          userPrompt: text,
          promptKey: makePromptKey(text, result.config.gameType),
          onProgress: assetProgressHandler,
          cancelToken: token
        });
        if (token.cancelled) {
          metrics.cancelRun();
          return; // stale run — the user moved on
        }
        metrics.mark('assets-ready');
        setTransitionPhase('done');
        onGenerate('custom', { ...gen.config, preloadedImages: gen.preloadedImages, assetMeta: gen.assetMeta });
      } catch (err) {
        if (token.cancelled || err.cancelled) {
          metrics.cancelRun();
          return; // cancelled ≠ failed — no static boot
        }
        metrics.mark('assets-failed');
        console.error('[Compilation Error] Overlay generation failed, using static theme:', err);
        if (overlayConfig) {
          setTransitionPhase('done');
          onGenerate('custom', toStaticThemeConfig(overlayConfig));
        } else {
          // Config generation itself failed (local, near-infallible) — plain reset.
          // Nothing boots after this, so the run would otherwise stay open and be
          // adopted by whatever mounts next.
          metrics.cancelRun();
          setTransitionPhase('idle');
          setProgress(0);
        }
      } finally {
        setIsGenerating(false);
      }
      return;
    }

    console.log('[ScreenZero] Starting processPrompt compilation with prompt:', text);
    metrics.beginRun('generate', { via: 'prompt', promptChars: text.length });
    setIsGenerating(true);
    setTransitionPhase('compiling');
    setTerminalLogs([]);
    setProgress(0);
    setPhaserLoaded(false);

    // Hoisted so the catch can downgrade to static art once a config exists
    let generatedConfig = null;
    try {
      const result = await generateGameConfig(text, (logText, progressVal) => {
        console.log(`[ScreenZero Progress Callback] Log: "${logText}", Progress: ${progressVal}%`);
        setTerminalLogs(prev => [...prev, logText]);
        setProgress(Math.min(progressVal, 70));
      });
      generatedConfig = result.config;
      // Prompt parsing used to sit entirely OUTSIDE the measurement — the old
      // clock started inside generateOrRestoreAssets, after this line.
      metrics.mark('config');
      metrics.annotate({ gameType: result.config.gameType });

      setTerminalLogs(prev => [...prev, `[ENGINE] Starting asset generation via ${isGeminiConfigured() ? 'Gemini AI' : 'built-in theme artwork (no API key)'}...`]);
      setProgress(75);

      const gen = await generateOrRestoreAssets({
        config: result.config,
        userPrompt: text,
        promptKey: makePromptKey(text, result.config.gameType),
        onProgress: assetProgressHandler,
        cancelToken: beginRun() // defensive symmetry with the overlay paths
      });

      metrics.mark('assets-ready');
      setTerminalLogs(prev => [...prev, '[ENGINE] Booting game scene and registering WebGL textures...']);
      onStartTransition({ ...gen.config, preloadedImages: gen.preloadedImages, assetMeta: gen.assetMeta });
    } catch (err) {
      metrics.mark('assets-failed');
      console.error('[Compilation Error] Game generation or preloading failed:', err);
      if (generatedConfig) {
        // Asset generation died — launch on built-in theme art instead of dead-ending.
        // Stay in 'compiling': the static boot fires phaser-load-complete → 100% → fade.
        if (!err.cacheOnlyMiss) { // cache-only miss already explained itself via onProgress
          setTerminalLogs(prev => [...prev, '[ASSETS] AI generation unavailable — launching with built-in theme artwork. Add a Gemini API key (top right) for AI assets.']);
        }
        onStartTransition(toStaticThemeConfig(generatedConfig));
      } else {
        // Config generation itself failed (local, near-infallible) — plain reset
        metrics.cancelRun();
        setIsGenerating(false);
        setTransitionPhase('idle');
        setProgress(0);
      }
    }
  };

  const generateRandom = () => {
    const mode = getRandomMode(selectedMode);
    const config = { ...GAME_PRESETS[mode] };
    config.difficulty = getRandomDifficulty();
    
    applyDifficulty(config, mode);
    
    const theme = 'ice';
    config.themeKey = theme;
    
    config.gameName = generateTitle("", mode, theme);
    // Boolean flag only — true routes to AI (dyn_*) textures once generation
    // succeeds; keyless goes straight to built-in theme art.
    config.dynamicAssetUrls = isGeminiConfigured() ? true : null;

    startCompilationSequence(config, "Random Preset", makePresetKey(mode));
  };

  const applyDifficulty = (config, mode) => {
    const diff = config.difficulty; // 1 to 10
    if (mode === 'standard') {
      config.runSpeed = 200 + (diff * 40); // 240 to 600
      config.obstacleDelay = 2000 - (diff * 120); // 1880 to 800
    } else if (mode === 'action_quest') {
      config.actionEnemyCount = Math.floor(diff * 1.5); // 1 to 15
      config.actionJumpHeight = 400 + (diff * 30);
    }
  };

  return (
    <div className="pm-screenzero-container" style={{
      position: 'absolute', inset: 0,
      zIndex: 9999,
      opacity: transitionPhase === 'fading' ? 0 : 1,
      // Once faded out this overlay must never block the game UI underneath
      pointerEvents: (transitionPhase === 'fading' || transitionPhase === 'done') ? 'none' : 'auto',
      transition: 'opacity 1.0s ease-in-out'
    }}>
      {/* Toast Notification */}
      {toastMessage && (
        <div className="pm-toast">
          {toastMessage}
        </div>
      )}
      {/* Neon sweep scanline during compilation */}
      {(transitionPhase === 'compiling' || transitionPhase === 'fading') && (
        <div style={{
          position: 'absolute',
          left: 0,
          width: '100%',
          height: '6px',
          background: 'linear-gradient(to bottom, transparent, var(--pm-accent-teal), transparent)',
          boxShadow: '0 0 20px 4px var(--pm-accent-teal)',
          zIndex: 1000,
          pointerEvents: 'none',
          animation: 'scanlineSweep 2.5s infinite linear'
        }} />
      )}

      {/* World Background Cycles */}
      {WORLDS.map((world, worldIdx) => {
        const isActive = worldIdx === currentWorldIndex;
        return (
          <div
            key={world.name}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 0,
              opacity: isActive ? 1 : 0,
              transition: 'opacity 1.5s ease-in-out',
              pointerEvents: 'none',
              filter: world.filter || 'none'
            }}
          >
            {world.layers.map((layerUrl, layerIdx) => {
              const depthScale = layerIdx + 1;
              return (
                <div
                  key={layerUrl}
                  style={getBackgroundStyle(
                    layerIdx === 0 ? 0.85 : 1.0,
                    depthScale,
                    layerUrl
                  )}
                  className="parallax-layer"
                />
              );
            })}
          </div>
        );
      })}

      
      {/* Dark gradient overlay */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1,
        background: `
          linear-gradient(180deg, rgba(7,10,16,0.65) 0%, rgba(7,10,16,0.3) 40%, rgba(7,10,16,0.5) 75%, rgba(7,10,16,0.92) 100%)
        `
      }} />

      {/* Grid lines */}
      <svg style={{ position: 'fixed', inset: 0, zIndex: 2, width: '100%', height: '100%', opacity: 0.06 }}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(0,229,153,0.5)" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Floating glow orbs */}
      <div style={{
        position: 'fixed', width: '400px', height: '400px',
        background: 'radial-gradient(circle, rgba(13,180,185,0.12) 0%, transparent 70%)',
        top: '-5%', left: '-5%', borderRadius: '50%', filter: 'blur(50px)',
        animation: 'float 14s infinite alternate', zIndex: 2
      }} />
      <div style={{
        position: 'fixed', width: '350px', height: '350px',
        background: 'radial-gradient(circle, rgba(162,89,255,0.08) 0%, transparent 70%)',
        bottom: '10%', right: '-5%', borderRadius: '50%', filter: 'blur(50px)',
        animation: 'float 18s infinite alternate-reverse', zIndex: 2
      }} />

      {/* Top right: cache-only toggle + API key control */}
      <div style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 100, display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button
          onClick={toggleCacheOnly}
          disabled={isGenerating}
          title={'Cache only: reuse cached art (free) instead of generating. No cached match = built-in theme art. Never spends on image generation.'}
          style={{
            height: '32px', padding: '0 10px', borderRadius: '8px',
            fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '5px',
            backdropFilter: 'blur(8px)',
            ...(cacheOnly
              ? { background: 'rgba(0, 229, 153, 0.15)', border: '1px solid var(--pm-accent-teal)', color: 'var(--pm-accent-teal)' }
              : { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)' })
          }}
        >
          💾 Cache only{cacheOnly ? ' ✓' : ''}
        </button>
        {HAS_ENV_GEMINI_KEY ? (
              <button
                onClick={() => showToast('Using Gemini key from environment (.env)')}
                title="Gemini key active (from .env)"
                style={API_KEY_TICK_STYLE}
              >
                ✓
              </button>
            ) : (apiKey && !isEditingKey) ? (
              <button
                onClick={() => { setKeyInput(apiKey); setIsEditingKey(true); }}
                title="Gemini key saved — click to change"
                style={API_KEY_TICK_STYLE}
              >
                ✓
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = keyInput.trim();
                  localStorage.setItem('GEMINI_API_KEY', trimmed);
                  setApiKey(trimmed);
                  setIsEditingKey(false);
                  showToast(trimmed ? 'Gemini key saved — assets will use Gemini AI.' : 'No key — games will use built-in theme artwork.');
                }}
                style={{
                  display: 'flex', gap: '6px', alignItems: 'center',
                  background: 'rgba(10, 15, 24, 0.85)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '8px', padding: '6px 8px',
                  backdropFilter: 'blur(8px)'
                }}
              >
                <label htmlFor="pm-gemini-key-input" style={{ color: '#fff', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Insert Gemini API key:
                </label>
                <input
                  id="pm-gemini-key-input"
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="AIza..."
                  autoComplete="off"
                  style={{
                    width: '150px', padding: '5px 8px', fontSize: '12px',
                    background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '6px', color: '#fff', outline: 'none'
                  }}
                />
                <button
                  type="submit"
                  style={{
                    background: 'rgba(162, 89, 255, 0.2)', border: '1px solid #a259ff',
                    color: '#a259ff', fontSize: '12px', fontWeight: 700,
                    padding: '5px 10px', borderRadius: '6px', cursor: 'pointer'
                  }}
                >
                  Save
                </button>
              </form>
            )}
      </div>

      {/* Close button for overlay */}
      {isOverlay && (
        <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 100 }}>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
              color: '#fff', fontSize: '14px',
              padding: '6px 14px', borderRadius: '8px', cursor: 'pointer',
              transition: 'all 0.2s', backdropFilter: 'blur(8px)'
            }}
            onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.2)'}
            onMouseLeave={(e) => e.target.style.background = 'rgba(255,255,255,0.08)'}
          >
            ✕ Close
          </button>
        </div>
      )}

      {/* Centered Grouped Layout Container */}
      <div className="pm-screenzero-main">
        {/* Hero logo and slogan */}
        <div className="pm-screenzero-hero" style={{
          zIndex: 3,
          pointerEvents: 'none',
          opacity: (transitionPhase === 'compiling' || transitionPhase === 'fading') ? 0.3 : 1,
          transition: 'all 0.6s ease-in-out'
        }}>
          <img
            src="/assets/Logo_PlayMint_(transparent).png"
            alt="PlayMint"
            className="pm-screenzero-logo"
            style={{ height: '38px', marginBottom: '12px', opacity: 0.95 }}
          />
          <p className="pm-screenzero-slogan" style={{
            margin: 0,
            fontFamily: 'var(--font-heading)',
            fontWeight: '700',
            color: 'var(--pm-text-secondary)',
            letterSpacing: '1.5px',
            opacity: 0.8,
            textTransform: 'uppercase',
            fontSize: 'clamp(14px, 2.5vw, 18px)',
            textAlign: 'center'
          }}>
            From words to worlds
          </p>
        </div>

        {/* ===== BOTTOM: Prompt dock ===== */}
        <div className="pm-screenzero-dock">
          {(transitionPhase === 'compiling' || transitionPhase === 'fading') ? (
            /* ===== COMPILER TERMINAL (Bottom-Docked Version) ===== */
            <div style={{
              width: 'min(640px, 100%)',
              background: 'rgba(6, 10, 16, 0.92)',
              border: '1px solid var(--pm-accent-teal)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: '0 12px 40px rgba(0, 0, 0, 0.6), 0 0 25px rgba(0, 229, 153, 0.15)',
              backdropFilter: 'blur(16px)',
              fontFamily: 'monospace',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              minHeight: '280px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '8px' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff5f56' }} />
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ffbd2e' }} />
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#27c93f' }} />
                </div>
                <span style={{ color: 'var(--pm-text-tertiary)', fontSize: '10px', fontWeight: 'bold', letterSpacing: '1px' }}>PLAYMINT COMPILER v2.0</span>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '160px' }}>
                {terminalLogs.map((log, i) => {
                  let color = '#fff';
                  if (log.startsWith('[SYSTEM]')) color = 'var(--pm-accent-teal)';
                  else if (log.startsWith('[PROMPT]')) color = 'var(--pm-accent-orange)';
                  else if (log.startsWith('[THEME]')) color = '#8A2BE2';
                  else if (log.startsWith('[PHYSIC]')) color = '#3182CE';
                  else if (log.startsWith('[ENGINE]')) color = 'var(--pm-accent-teal)';

                  return (
                    <div key={i} style={{
                      color,
                      fontSize: '12px',
                      lineHeight: '1.5',
                      textAlign: 'left',
                      fontFamily: 'monospace',
                      textShadow: `0 0 6px ${color}40`,
                      whiteSpace: 'pre-wrap'
                    }}>
                      {log}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--pm-text-secondary)' }}>
                  <span>Compiling World Matrix</span>
                  <span style={{ color: 'var(--pm-accent-teal)', fontWeight: 'bold' }}>{Math.round(progress)}%</span>
                </div>
                <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{
                    width: `${progress}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, var(--pm-accent-teal), #8A2BE2)',
                    boxShadow: '0 0 8px var(--pm-accent-teal)',
                    borderRadius: '3px',
                    transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                  }} />
                </div>
              </div>
            </div>
          ) : (
            /* ===== PROMPT DOCK CONTENT ===== */
            <div ref={formRef} className="pm-screenzero-content">
              {/* Input card */}
              <div className="pm-prompt-card">
                <form onSubmit={handleGenerate}>
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. 'city runner lava' or 'forest quest'"
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="pm-btn pm-btn-primary"
                    disabled={isGenerating}
                  >
                    Generate
                  </button>
                  <button
                    type="button"
                    onClick={handleQuickStart}
                    className="pm-btn pm-btn-outline"
                    disabled={isGenerating}
                  >
                    Quick Start
                  </button>
                </form>

                {/* Fresh-art escape hatch lives in the Creator Panel now: ask it
                    to "redraw everything" on a running game. The cache toggle
                    moved to the top-right next to the API key controls. */}

                {/* Game Mode Bubbles Selector */}
                <div className="pm-screenzero-modes">
                  <div className="modes-header">
                    <p>Select game mode</p>
                    <button
                      type="button"
                      onClick={() => setShowInfoModal(true)}
                      className="info-btn"
                      title="View Game Mode Details"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </button>
                  </div>
                  <div className="mode-bubbles-row playable-row">
                    {AVAILABLE_MODES.map((mode) => {
                      const isActive = selectedMode === mode.key;
                      return (
                        <button
                          key={mode.key}
                          type="button"
                          disabled={isGenerating}
                          onClick={() => setSelectedMode(isActive ? null : mode.key)}
                          className={`mode-bubble playable ${isActive ? 'active' : ''}`}
                        >
                          <span className="dot" />
                          {mode.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="section-divider">
                    <span>Coming Soon</span>
                  </div>

                  <div className="mode-bubbles-row soon-row">
                    {COMING_SOON_MODES.map((mode) => (
                      <button
                        key={mode.key}
                        type="button"
                        onClick={() => showToast(`${mode.label} is coming soon!`)}
                        className="mode-bubble locked"
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Suggestion Chips */}
                <div className="pm-prompt-chips">
                  {['lava runner', 'ice quest', 'forest sprint', 'city runner lava', 'space quest'].map((example, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleExampleClick(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes scanlineSweep {
          0% { top: -5%; }
          100% { top: 105%; }
        }
        @keyframes parallaxFar {
          0% { transform: scale(1.06) translateX(1%); }
          100% { transform: scale(1.06) translateX(-1%); }
        }
        @keyframes parallaxMid {
          0% { transform: scale(1.12) translateX(2%); }
          100% { transform: scale(1.12) translateX(-2%); }
        }
        @keyframes parallaxNear {
          0% { transform: scale(1.2) translateX(3.5%); }
          100% { transform: scale(1.2) translateX(-3.5%); }
        }
        @keyframes float {
          0% { transform: translateY(0) scale(1); }
          100% { transform: translateY(-15px) scale(1.03); }
        }
        @keyframes dockRise {
          0% { opacity: 0; transform: translateY(20px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes sloganFade {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes toastFadeIn {
          from { opacity: 0; transform: translate(-50%, 20px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }

        .pm-screenzero-main {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          margin: auto;
          width: 100%;
          z-index: 3;
          position: relative;
          box-sizing: border-box;
        }

        .pm-ambient-world-label {
          position: absolute;
          top: 16px;
          right: 16px;
          z-index: 100;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 2px;
          pointer-events: none;
          text-align: right;
        }

        .pm-ambient-label-title {
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: var(--pm-text-tertiary);
          font-weight: 700;
          opacity: 0.65;
        }

        .pm-ambient-label-name {
          font-size: 12px;
          color: var(--pm-accent-teal);
          font-weight: 800;
          text-shadow: 0 0 10px rgba(0, 229, 153, 0.4);
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .pm-toast {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(10, 15, 24, 0.95);
          border: 1px solid var(--pm-accent-teal);
          color: #fff;
          padding: 8px 16px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          z-index: 10000;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 0 12px rgba(0,229,153,0.25);
          animation: toastFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          letter-spacing: 0.5px;
          pointer-events: none;
        }

        /* Default: Mobile first styles */
        .pm-screenzero-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 12px 16px;
          box-sizing: border-box;
          height: 100vh;
        }

        .pm-screenzero-hero {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: 100%;
          margin-bottom: 24px;
          animation: sloganFade 0.8s ease-out;
        }

        .pm-screenzero-logo {
          height: 30px;
          margin-bottom: 8px;
          opacity: 0.95;
        }

        .pm-screenzero-slogan {
          margin: 0;
          font-family: var(--font-heading);
          font-weight: 700;
          color: var(--pm-text-secondary);
          letter-spacing: 1.2px;
          opacity: 0.8;
          text-transform: uppercase;
          font-size: 13px;
          text-align: center;
        }

        .pm-screenzero-dock {
          width: 100%;
          margin-top: 0;
          padding: 0 4px 16px 4px;
          display: flex;
          flex-direction: column;
          align-items: center;
          z-index: 3;
          position: relative;
          animation: dockRise 0.6s ease-out;
          box-sizing: border-box;
        }

        .pm-screenzero-content {
          width: 100%;
          box-sizing: border-box;
        }

        .pm-prompt-card {
          background: rgba(10, 15, 24, 0.85);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
          padding: 12px;
          box-sizing: border-box;
          backdrop-filter: blur(16px);
        }

        .pm-prompt-card form {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 6px;
          background: rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 10px;
          padding: 4px;
        }

        .pm-prompt-card input {
          padding: 8px 12px;
          font-size: 13px;
          border-radius: 6px;
          background-color: transparent;
          border: none;
          color: #fff;
          outline: none;
          width: 100%;
          box-sizing: border-box;
        }

        .pm-prompt-card button.pm-btn-primary {
          padding: 6px 14px;
          font-size: 12px;
          border-radius: 6px;
          font-weight: bold;
          cursor: pointer;
        }

        .pm-prompt-card button.pm-btn-outline {
          display: none; /* Hide Quick Start on mobile form row to save width */
        }

        .pm-screenzero-modes {
          margin-top: 12px;
          text-align: center;
        }

        .pm-screenzero-modes p {
          margin: 0 0 8px 0;
          font-size: 10px;
          font-weight: 700;
          color: var(--pm-text-secondary);
          letter-spacing: 0.8px;
          text-transform: uppercase;
        }

        .mode-bubbles-row {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          justify-content: center;
          margin-bottom: 4px;
        }

        .mode-bubble {
          padding: 5px 11px;
          border-radius: 999px;
          font-size: 10px;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          transition: all 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
          cursor: pointer;
        }

        .mode-bubble.playable {
          font-weight: 700;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: var(--pm-text-secondary);
        }
        .mode-bubble.playable:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
          color: #fff;
        }
        .mode-bubble.playable.active {
          background: rgba(0, 229, 153, 0.15);
          border: 1px solid var(--pm-accent-teal);
          color: var(--pm-accent-teal);
          box-shadow: 0 0 12px rgba(0, 229, 153, 0.2);
        }

        .mode-bubble.playable .dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.3);
          transition: background 0.2s ease;
        }
        .mode-bubble.playable.active .dot {
          background: var(--pm-accent-teal);
        }

        .mode-bubble.locked {
          font-weight: 500;
          background: rgba(255, 255, 255, 0.01);
          border: 1px dashed rgba(255, 255, 255, 0.06);
          color: var(--pm-text-tertiary);
          opacity: 0.5;
        }
        .mode-bubble.locked:hover {
          opacity: 0.8;
          border-color: rgba(255, 255, 255, 0.12);
          color: var(--pm-text-secondary);
        }

        .section-divider {
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 10px 0 6px 0;
          width: 100%;
        }
        .section-divider::before,
        .section-divider::after {
          content: '';
          flex: 1;
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .section-divider span {
          padding: 0 8px;
          font-size: 8px;
          font-weight: 700;
          color: var(--pm-text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }

        .mode-desc-bar {
          min-height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-top: 6px;
          padding: 0 4px;
        }

        .mode-desc-bar p {
          margin: 0;
          font-size: 10px;
          color: var(--pm-text-secondary);
          line-height: 1.4;
          transition: all 0.2s ease;
          text-align: center;
          font-style: italic;
          opacity: 0.95;
        }
        .mode-desc-bar p.hovered {
          color: var(--pm-text-primary);
          font-style: normal;
        }

        .pm-prompt-chips {
          display: none; /* Hide suggested chips on mobile by default to keep clean */
        }

        /* Desktop Layering: min-width: 641px */
        @media (min-width: 641px) {
          .pm-screenzero-container {
            padding: clamp(24px, 4vh, 48px) clamp(24px, 4vw, 48px);
          }
          .pm-screenzero-logo {
            height: 38px;
            margin-bottom: 12px;
          }
          .pm-screenzero-slogan {
            font-size: clamp(14px, 2.5vw, 18px);
            letter-spacing: 1.5px;
          }
          .pm-screenzero-dock {
            padding: 0 clamp(16px, 4vw, 48px) clamp(24px, 4vh, 48px);
          }
          .pm-screenzero-content {
            width: min(640px, 100%);
          }
          .pm-prompt-card {
            padding: 16px;
            border-radius: 20px;
          }
          .pm-prompt-card form {
            grid-template-columns: 1fr auto auto;
            gap: 8px;
            padding: 6px;
            border-radius: 12px;
          }
          .pm-prompt-card input {
            padding: 10px 14px;
            font-size: 14px;
          }
          .pm-prompt-card button.pm-btn-primary {
            padding: 8px 16px;
            font-size: 12px;
            border-radius: 8px;
          }
          .pm-prompt-card button.pm-btn-outline {
            display: inline-block;
            padding: 8px 12px;
            font-size: 11px;
            border-radius: 8px;
          }
          .pm-screenzero-modes {
            margin-top: 16px;
          }
          .pm-screenzero-modes p {
            font-size: 11px;
            margin-bottom: 10px;
          }
          .mode-bubbles-row {
            gap: 8px;
            margin-bottom: 8px;
          }
          .mode-bubble {
            padding: 6px 14px;
            font-size: 11px;
            gap: 6px;
          }
          .mode-bubble.playable .dot {
            width: 6px;
            height: 6px;
          }
          .mode-bubble.locked {
            border-color: rgba(255, 255, 255, 0.08);
          }
          .section-divider {
            margin: 12px 0 8px 0;
          }
          .section-divider span {
            font-size: 9px;
            padding: 0 10px;
          }
          .mode-desc-bar {
            margin-top: 8px;
            min-height: 26px;
          }
          .mode-desc-bar p {
            font-size: 11px;
          }
          .pm-prompt-chips {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: center;
            margin-top: 12px;
          }
          .pm-prompt-chips button {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: var(--pm-text-secondary);
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 10px;
            cursor: pointer;
            transition: all 0.2s ease;
            opacity: 0.8;
          }
          .pm-prompt-chips button:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            opacity: 1;
          }
        }

        @media (max-height: 550px) {
          .pm-screenzero-slogan {
            display: none !important;
          }
          .pm-screenzero-logo {
            height: 22px !important;
            margin-bottom: 4px !important;
          }
          .pm-screenzero-hero {
            flex: 0 0 auto !important;
            margin-top: 8px !important;
            margin-bottom: 8px !important;
          }
          .pm-screenzero-dock {
            padding-bottom: 10px !important;
          }
          .pm-prompt-card {
            padding: 8px 10px !important;
            border-radius: 12px !important;
          }
          .pm-screenzero-modes {
            margin-top: 6px !important;
          }
          .pm-prompt-chips {
            display: none !important;
          }
          .section-divider {
            margin: 6px 0 4px 0 !important;
          }
        }

        /* Modal styling */
        .info-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(4, 6, 10, 0.85);
          backdrop-filter: blur(8px);
          z-index: 100000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          box-sizing: border-box;
          animation: sloganFade 0.3s ease-out;
        }

        .info-modal-card {
          background: rgba(16, 22, 34, 0.98);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 20px;
          width: 100%;
          max-width: 500px;
          max-height: 80vh;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 30px rgba(0, 229, 153, 0.05);
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
          overflow: hidden;
        }

        .info-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .info-modal-header h3 {
          margin: 0;
          font-family: var(--font-heading);
          font-size: 13px;
          font-weight: 800;
          color: var(--pm-text-primary);
          letter-spacing: 1.2px;
        }

        .info-modal-close {
          background: none;
          border: none;
          color: var(--pm-text-secondary);
          cursor: pointer;
          font-size: 16px;
          padding: 4px;
          transition: color 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .info-modal-close:hover {
          color: #fff;
        }

        .info-modal-body {
          padding: 16px 20px;
          overflow-y: auto;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 12px;
          text-align: left;
        }

        .info-modal-section-title {
          font-size: 10px;
          font-weight: 800;
          color: var(--pm-accent-teal);
          text-transform: uppercase;
          letter-spacing: 0.8px;
          margin-top: 4px;
          margin-bottom: 2px;
        }
        .info-modal-section-title.soon {
          color: var(--pm-text-tertiary);
          margin-top: 12px;
        }

        .info-modal-item {
          display: flex;
          flex-direction: column;
          gap: 3px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.04);
          border-radius: 8px;
          padding: 8px 12px;
        }

        .info-modal-item-title {
          font-size: 12px;
          font-weight: 700;
        }
        .info-modal-item-title.playable {
          color: var(--pm-accent-teal);
        }
        .info-modal-item-title.locked {
          color: var(--pm-text-secondary);
        }

        .info-modal-item-desc {
          font-size: 10px;
          color: var(--pm-text-secondary);
          line-height: 1.4;
        }

        .modes-header {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          margin-bottom: 8px;
        }
        .modes-header p {
          margin: 0 !important;
          font-size: 10px;
          font-weight: 700;
          color: var(--pm-text-secondary);
          letter-spacing: 0.8px;
          text-transform: uppercase;
        }
        .info-btn {
          background: none;
          border: none;
          color: var(--pm-text-secondary);
          cursor: pointer;
          padding: 2px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }
        .info-btn:hover {
          color: var(--pm-accent-teal);
          transform: scale(1.1);
        }

        /* Desktop Modal sizing */
        @media (min-width: 641px) {
          .info-modal-header h3 {
            font-size: 14px;
          }
          .info-modal-item-title {
            font-size: 13px;
          }
          .info-modal-item-desc {
            font-size: 11px;
          }
        }
      `}</style>

      {/* Info Modal Dialog */}
      {showInfoModal && (
        <div className="info-modal-backdrop" onClick={() => setShowInfoModal(false)}>
          <div className="info-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="info-modal-header">
              <h3>GAME PROTOCOLS REFERENCE</h3>
              <button className="info-modal-close" onClick={() => setShowInfoModal(false)}>✕</button>
            </div>
            <div className="info-modal-body">
              <div className="info-modal-section-title">Playable Protocols</div>
              {AVAILABLE_MODES.map(mode => (
                <div key={mode.key} className="info-modal-item">
                  <div className="info-modal-item-title playable">{mode.label}</div>
                  <div className="info-modal-item-desc">{mode.desc}</div>
                </div>
              ))}
              
              <div className="info-modal-section-title soon">Coming Soon</div>
              {COMING_SOON_MODES.map(mode => (
                <div key={mode.key} className="info-modal-item">
                  <div className="info-modal-item-title locked">{mode.label}</div>
                  <div className="info-modal-item-desc">{mode.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScreenZero;
