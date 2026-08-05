import React, { useState } from 'react';
import { GAME_PRESETS } from '../gameConfig';
import { IconShare, IconExport, IconImport, IconReset, IconHome } from './Icons';
import { downloadCostReport } from '../game/assetPipeline/costReport';

const RunnerControls = ({ liveParams, onSliderChange }) => (
  <>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Speed</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.runSpeed || 350)}</span>
      </div>
      <input type="range" className="pm-slider" name="runSpeed" min="100" max="1000" step="10" value={liveParams.runSpeed || 350} onChange={onSliderChange} />
    </div>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Jump Force</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.jumpForce || 750)}</span>
      </div>
      <input type="range" className="pm-slider" name="jumpForce" min="200" max="1500" step="10" value={liveParams.jumpForce || 750} onChange={onSliderChange} />
    </div>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Gravity</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.gravity || 1800)}</span>
      </div>
      <input type="range" className="pm-slider" name="gravity" min="500" max="3500" step="50" value={liveParams.gravity || 1800} onChange={onSliderChange} />
    </div>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Spawn Delay (ms)</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.obstacleDelay || 1200)}</span>
      </div>
      <input type="range" className="pm-slider" name="obstacleDelay" min="400" max="2500" step="100" value={liveParams.obstacleDelay || 1200} onChange={onSliderChange} />
    </div>
  </>
);

const PlatformerControls = ({ liveParams, onSliderChange }) => (
  <>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Jump Height</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.actionJumpHeight || 600)}</span>
      </div>
      <input type="range" className="pm-slider" name="actionJumpHeight" min="200" max="1500" step="10" value={liveParams.actionJumpHeight || 600} onChange={onSliderChange} />
    </div>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Gravity</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.actionGravity || 1500)}</span>
      </div>
      <input type="range" className="pm-slider" name="actionGravity" min="500" max="3500" step="50" value={liveParams.actionGravity || 1500} onChange={onSliderChange} />
    </div>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label className="pm-label" style={{ margin: 0 }}>Enemy Count</label>
        <span style={{ fontSize: '13px', color: 'var(--pm-accent-teal)', fontWeight: '600' }}>{Math.round(liveParams.actionEnemyCount || 5)}</span>
      </div>
      <input type="range" className="pm-slider" name="actionEnemyCount" min="0" max="20" step="1" value={liveParams.actionEnemyCount || 5} onChange={onSliderChange} />
    </div>
    {/* Temporarily disabled
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
      <label className="pm-label" style={{ margin: 0 }}>Enable Projectiles</label>
      <input type="checkbox" checked={!!liveParams.actionProjectileEnabled} onChange={(e) => setLiveParams(prev => ({ ...prev, actionProjectileEnabled: e.target.checked }))} style={{ accentColor: 'var(--pm-accent-teal)', width: '20px', height: '20px', cursor: 'pointer' }} />
    </div>
    */}
  </>
);

const ConfigActions = ({ liveParams, setLiveParams, setPresetKey, onHomeClick }) => {
  const [exportStatus, setExportStatus] = useState('idle');
  const [isImporting, setIsImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');

  const handleExport = () => {
    try {
      const configString = JSON.stringify(liveParams, null, 2);
      navigator.clipboard.writeText(configString);
      setExportStatus('copied');
      setTimeout(() => setExportStatus('idle'), 2000);
    } catch (error) {
      console.error('Failed to copy config to clipboard:', error);
    }
  };

  const handleImportApply = () => {
    try {
      const importedConfig = JSON.parse(importText);
      if (typeof importedConfig === 'object' && importedConfig !== null && Object.keys(importedConfig).length > 0) {
        setLiveParams({ gameName: 'PlayMint Core', ...importedConfig });
        setPresetKey('custom');
        setIsImporting(false);
        setImportError('');
      } else {
        setImportError('Invalid format.');
      }
    } catch (error) {
      console.error('Failed to import configuration:', error);
      setImportError('Invalid JSON.');
    }
  };

  if (isImporting) {
    return (
      <div className="pm-card" style={{ padding: '16px' }}>
        <label className="pm-label">Paste Config JSON</label>
        <textarea
          className="pm-input"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          style={{ height: '80px', fontFamily: 'monospace', marginBottom: '10px' }}
        />
        {importError && <p style={{ color: '#ef4444', fontSize: '12px', marginBottom: '10px' }}>{importError}</p>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <button className="pm-btn pm-btn-primary" onClick={handleImportApply} style={{ padding: '8px' }}>Apply</button>
          <button className="pm-btn pm-btn-outline" onClick={() => { setIsImporting(false); setImportError(''); }} style={{ padding: '8px' }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
        <button className="pm-btn pm-btn-outline" onClick={onHomeClick} style={{ padding: '8px', fontSize: '16px', lineHeight: 1 }} title="Home">
          <IconHome />
        </button>
        <button className="pm-btn pm-btn-outline" onClick={handleExport} style={{ padding: '8px', fontSize: '16px', lineHeight: 1 }} title="Export Config">
          {exportStatus === 'copied' ? '✓' : <IconExport />}
        </button>
        <button className="pm-btn pm-btn-outline" onClick={() => { setIsImporting(true); setImportText(''); setImportError(''); }} style={{ padding: '8px', fontSize: '16px', lineHeight: 1 }} title="Import Config"><IconImport /></button>
      </div>
      <button
        className="pm-btn pm-btn-muted"
        onClick={() => {
          setLiveParams(() => ({ 
            ...GAME_PRESETS['standard'], 
            themeKey: 'ice',
            gameName: 'PlayMint Runner' 
          }));
          setPresetKey('standard');
        }}
        style={{ marginTop: '4px', fontSize: '14px' }}
        title="Reset to Default"
      >
        <IconReset /> Reset
      </button>
    </div>
  );
};

/* Extracted share button with its own state */
const ShareGameButton = ({ liveParams }) => {
  const [status, setStatus] = useState('idle');
  const handleShare = () => {
    try {
      const configString = btoa(JSON.stringify(liveParams));
      const shareUrl = `${window.location.origin}${window.location.pathname}${window.location.search}#config=${configString}`;
      navigator.clipboard.writeText(shareUrl);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      console.error(e);
    }
  };
  return (
    <button
      className="pm-btn pm-btn-primary"
      onClick={handleShare}
      title="Share Game"
      style={{ justifyContent: 'center', width: '100%', gap: '6px' }}
    >
      {status === 'copied' ? '✓' : <IconShare />}
    </button>
  );
};

const CreatorPanel = ({
  isOpen,
  onClose,
  onOpenSelector,
  liveParams,
  setLiveParams,
  presetKey,
  setPresetKey,
  onSliderChange,
  onPromptGenerate,
  onHomeClick,
}) => {
  const isCustom = presetKey === 'custom';
  const [promptText, setPromptText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptResult, setPromptResult] = useState(null);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('GEMINI_API_KEY') || '');

  const handlePromptSubmit = async () => {
    if (!promptText.trim() || !onPromptGenerate) return;

    // Immediately blur the text input field synchronously before closing/unmounting the panel
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }

    setPromptBusy(true);
    setPromptResult(null);
    try {
      const result = await onPromptGenerate(promptText.trim());
      setPromptText('');
      // Live tweaks return a summary of what changed; full regenerations reboot the game
      if (result && result.summary) {
        setPromptResult({ ok: result.applied !== false, text: result.summary });
      }
    } finally {
      setPromptBusy(false);
    }
  };

  const handleDifficultyChange = (e) => {
    const diff = parseInt(e.target.value, 10);
    const mode = liveParams.gameType;
    
    setLiveParams(prev => {
      const config = { ...prev, difficulty: diff };
      if (mode === 'runner') {
        config.runSpeed = 200 + (diff * 40);
        config.obstacleDelay = 2000 - (diff * 120);
      } else if (mode === 'platformer') {
        config.actionEnemyCount = Math.floor(diff * 1.5);
        config.actionJumpHeight = 400 + (diff * 30);
      }
      return config;
    });
  };

  return (
    <div 
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      className="pm-glass-panel"
      style={{
        position: 'fixed', top: 0, right: 0, height: '100dvh',
        width: '100vw', maxWidth: '380px',
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)', zIndex: 1000,
        display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--pm-border)',
        overflow: 'hidden',
        pointerEvents: 'auto'
      }}
    >
      {/* Atmospheric forge/world-creation backdrop */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden' }}>
        {/* Deep cosmic gradient */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(ellipse at 20% 30%, rgba(0,229,153,0.10) 0%, transparent 60%),
            radial-gradient(ellipse at 80% 70%, rgba(138,43,226,0.08) 0%, transparent 50%),
            radial-gradient(ellipse at 50% 0%, rgba(255,140,0,0.05) 0%, transparent 40%),
            linear-gradient(160deg, rgba(7,10,16,0.95) 0%, rgba(15,22,37,0.9) 100%)
          `
        }} />
        {/* Subtle grid overlay */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.04 }}>
          <defs>
            <pattern id="forge-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#00E599" strokeWidth="0.3"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#forge-grid)" />
        </svg>
        {/* Floating creation sparks */}
        <div style={{
          position: 'absolute', width: '4px', height: '4px', borderRadius: '50%',
          background: 'var(--pm-accent-teal)', opacity: 0.3,
          top: '15%', right: '20%',
          animation: 'forgeDrift 6s infinite alternate', zIndex: 0
        }} />
        <div style={{
          position: 'absolute', width: '3px', height: '3px', borderRadius: '50%',
          background: 'var(--pm-accent-orange)', opacity: 0.25,
          top: '45%', right: '60%',
          animation: 'forgeDrift 8s infinite alternate-reverse', zIndex: 0
        }} />
        <div style={{
          position: 'absolute', width: '5px', height: '5px', borderRadius: '50%',
          background: 'var(--pm-accent-purple)', opacity: 0.2,
          top: '70%', right: '25%',
          animation: 'forgeDrift 7s infinite alternate', zIndex: 0
        }} />
        <div style={{
          position: 'absolute', width: '2px', height: '2px', borderRadius: '50%',
          background: '#fff', opacity: 0.4,
          top: '30%', right: '75%',
          animation: 'forgeDrift 9s infinite alternate-reverse', zIndex: 0
        }} />
        {/* Faint glow at panel edge */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
          background: 'linear-gradient(90deg, transparent, var(--pm-accent-teal), transparent)',
          opacity: 0.4
        }} />
      </div>

      {/* Content layer on top of backdrop */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ padding: '24px', borderBottom: '1px solid var(--pm-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backdropFilter: 'blur(4px)' }}>
          <div>
            <h2 className="pm-heading" style={{ fontSize: '20px', margin: 0 }}>Creator Panel</h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--pm-text-secondary)', fontSize: '24px', cursor: 'pointer' }}>✕</button>
        </div>

      <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>

        {/* 0. API Key Config */}
        <div>
          <button
            onClick={!!import.meta.env.VITE_GEMINI_API_KEY ? () => alert("Using API Key from environment (.env)") : () => {
              const key = prompt("Enter your Google Gemini API Key:", apiKey);
              if (key !== null) {
                const trimmed = key.trim();
                localStorage.setItem('GEMINI_API_KEY', trimmed);
                setApiKey(trimmed);
              }
            }}
            style={{
              width: '100%',
              background: (!!import.meta.env.VITE_GEMINI_API_KEY || apiKey) ? 'rgba(0, 229, 153, 0.1)' : 'rgba(255,255,255,0.05)',
              border: (!!import.meta.env.VITE_GEMINI_API_KEY || apiKey) ? '1px solid var(--pm-accent-teal)' : '1px solid var(--pm-border)',
              color: (!!import.meta.env.VITE_GEMINI_API_KEY || apiKey) ? 'var(--pm-accent-teal)' : 'var(--pm-text-secondary)',
              fontSize: '13px', padding: '8px 12px', borderRadius: '8px', cursor: 'pointer',
              display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px'
            }}
          >
            {!!import.meta.env.VITE_GEMINI_API_KEY ? '✓ Gemini Key Detected & Usable' : (apiKey ? '⚙️ Gemini Key Configured' : '⚙️ Configure Gemini Key')}
          </button>
        </div>

        {/* 1. Game Name */}
        <div>
          <label className="pm-label">Game Name</label>
          <input
            type="text"
            name="gameName"
            className="pm-input"
            value={liveParams.gameName || ''}
            onChange={(e) => setLiveParams(prev => ({ ...prev, gameName: e.target.value }))}
            placeholder="Enter Game Name"
          />
        </div>

        {/* 2. Prompt Input */}
        <div>
          <label className="pm-label">Regenerate with Prompt</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              className="pm-input"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="e.g. lava runner"
              onKeyDown={(e) => { if (e.key === 'Enter') handlePromptSubmit(); }}
              style={{ flex: 1 }}
            />
            <button
              className="pm-btn pm-btn-primary"
              onClick={handlePromptSubmit}
              disabled={promptBusy}
              style={{ padding: '10px 14px', whiteSpace: 'nowrap', fontSize: '15px' }}
              title="Generate"
            >
              {promptBusy ? '…' : '▶'}
            </button>
          </div>
          {promptResult && (
            <div style={{
              marginTop: '8px', fontSize: '12px', lineHeight: 1.4,
              color: promptResult.ok ? 'var(--pm-accent-teal)' : 'var(--pm-accent-orange)'
            }}>
              {promptResult.ok ? '✓ ' : ''}{promptResult.text}
            </div>
          )}
        </div>

        {/* 3. Share Game button (primary CTA at top) */}
        <ShareGameButton liveParams={liveParams} />

        {/* 4. Browse All Game Types — opens main selector */}
        <div>
          <label className="pm-label">Game Type</label>
          <button
            onClick={onOpenSelector}
            className="pm-btn pm-btn-outline"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Browse All Game Types ⋯
          </button>
        </div>

        {/* 5. Mode Options / Custom Tuning */}
        <div>
          <label className="pm-label">Mode Options</label>
          <button 
            onClick={() => setPresetKey('custom')}
            className={`pm-btn ${isCustom ? 'pm-btn-primary' : 'pm-btn-outline'}`}
            style={{ width: '100%', padding: '10px' }}
          >
            Custom Tuning
          </button>
        </div>

        {isCustom && (
          <div className="pm-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <h3 className="pm-heading" style={{ fontSize: '16px', margin: 0, borderBottom: '1px solid var(--pm-border)', paddingBottom: '10px' }}>Difficulty & Tuning</h3>
            
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <label className="pm-label" style={{ margin: 0 }}>Difficulty (Auto-scales)</label>
                <span style={{ fontSize: '13px', color: 'var(--pm-accent-purple)', fontWeight: '600' }}>{Math.round(liveParams.difficulty || 5)}</span>
              </div>
              <input type="range" className="pm-slider" name="difficulty" min="1" max="10" step="1" value={liveParams.difficulty || 5} onChange={handleDifficultyChange} />
            </div>

            <div style={{ width: '100%', height: '1px', background: 'var(--pm-border)', margin: '10px 0' }} />

            <h3 className="pm-heading" style={{ fontSize: '16px', margin: 0, borderBottom: '1px solid var(--pm-border)', paddingBottom: '10px' }}>Physics Override</h3>
              
            {liveParams.gameType === 'runner' ? (
              <RunnerControls liveParams={liveParams} onSliderChange={onSliderChange} />
            ) : liveParams.gameType === 'platformer' ? (
              <PlatformerControls liveParams={liveParams} onSliderChange={onSliderChange} />
            ) : (
              <div style={{ color: 'var(--pm-text-tertiary)', fontSize: '13px', fontStyle: 'italic', textAlign: 'center' }}>
                No physics parameters available.
              </div>
            )}
          </div>
        )}

        {/* 6. Config Actions at bottom */}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Downloadable spend report — only AI-generated games carry a cost tally
              (presets/share links have none, the free path costs $0) */}
          {liveParams?.assetMeta?.cost?.calls?.length > 0 && (
            <button
              className="pm-btn pm-btn-outline"
              onClick={() => downloadCostReport(liveParams)}
              style={{ width: '100%', padding: '10px' }}
              title="Download a text report of this game's AI generation spend: totals, per-call token log, per-asset providers"
            >
              💾 Cost Report (≈ ${(liveParams.assetMeta.cost.estUsd ?? 0).toFixed(2)})
            </button>
          )}
          <ConfigActions liveParams={liveParams} setLiveParams={setLiveParams} setPresetKey={setPresetKey} onHomeClick={onHomeClick} />
        </div>
      </div>
    </div>
    </div>
  );
};

export default CreatorPanel;
