import React from 'react';
import { setControlZones } from '../game/uiZones';

const THEME_ACCENTS = {
  lava: { primary: '#FF6B3D', semi: 'rgba(255, 107, 61, 0.25)' },
  ice: { primary: '#66AAFF', semi: 'rgba(102, 170, 255, 0.25)' },
  forest: { primary: '#66CC66', semi: 'rgba(102, 204, 102, 0.25)' },
  city: { primary: '#4488CC', semi: 'rgba(68, 136, 204, 0.25)' },
  space: { primary: '#AA66FF', semi: 'rgba(170, 102, 255, 0.25)' },
  default: { primary: '#00E599', semi: 'rgba(0, 229, 153, 0.25)' }
};

const MobileControls = ({ gameType, themeKey, projectilesEnabled }) => {
  const accent = THEME_ACCENTS[themeKey] || THEME_ACCENTS.default;
  const overlayRef = React.useRef(null);
  const dpadRef = React.useRef(null);
  const actionsRef = React.useRef(null);

  // Publish the real footprint of the buttons so the camera can keep the ground
  // line above them (src/game/uiZones.js). Measured rather than hardcoded: the
  // sizes are clamp()-based and change with viewport and orientation.
  // useLayoutEffect so the numbers exist before Phaser's first frame.
  React.useLayoutEffect(() => {
    const publish = () => {
      if (!overlayRef.current) return;
      setControlZones({
        base: overlayRef.current.getBoundingClientRect(),
        left: dpadRef.current?.getBoundingClientRect(),
        right: actionsRef.current?.getBoundingClientRect()
      });
    };
    publish();
    // Fonts/layout can settle a frame late on first paint; one rAF re-measure
    // costs nothing and avoids publishing a half-laid-out rect.
    const raf = requestAnimationFrame(publish);
    window.addEventListener('resize', publish);
    window.addEventListener('orientationchange', publish);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', publish);
      window.removeEventListener('orientationchange', publish);
      // Deliberately NOT cleared: the controls unmount on game over, and
      // dropping the inset there would snap the camera mid-death.
    };
  }, [gameType, projectilesEnabled]);

  const triggerInput = (action, state) => {
    // Dispatch a native browser custom event that the active Phaser game mode listens to
    window.dispatchEvent(new CustomEvent('game-input', { detail: { action, state } }));
    
    // Light mobile haptic vibration if supported
    if (state === 'down' && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch (e) {}
    }
  };

  const handleTouchStart = (action, e) => {
    e.preventDefault();
    triggerInput(action, 'down');
  };

  const handleTouchEnd = (action, e) => {
    e.preventDefault();
    triggerInput(action, 'up');
  };

  React.useEffect(() => {
    const handleGlobalTouchEnd = (e) => {
      if (e.touches.length === 0) {
        triggerInput('left', 'up');
        triggerInput('right', 'up');
      }
    };
    window.addEventListener('touchend', handleGlobalTouchEnd);
    window.addEventListener('touchcancel', handleGlobalTouchEnd);
    return () => {
      window.removeEventListener('touchend', handleGlobalTouchEnd);
      window.removeEventListener('touchcancel', handleGlobalTouchEnd);
    };
  }, []);

  const cssVariables = {
    '--theme-accent': accent.primary,
    '--theme-accent-semi': accent.semi
  };

  return (
    <div className="pm-mobile-overlay" style={cssVariables} ref={overlayRef}>
      {/* 1. Left D-Pad Cluster (only active in platformer mode) */}
      {gameType === 'platformer' ? (
        <div className="pm-mobile-dpad" ref={dpadRef} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <button
            className="pm-touch-btn"
            onTouchStart={(e) => handleTouchStart('left', e)}
            onTouchEnd={(e) => handleTouchEnd('left', e)}
            onTouchCancel={(e) => handleTouchEnd('left', e)}
            onMouseDown={() => triggerInput('left', 'down')}
            onMouseUp={() => triggerInput('left', 'up')}
            onMouseLeave={() => triggerInput('left', 'up')}
            aria-label="Move Left"
          >
            <svg viewBox="0 0 24 24">
              <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
            </svg>
          </button>
          
          <button
            className="pm-touch-btn"
            onTouchStart={(e) => handleTouchStart('right', e)}
            onTouchEnd={(e) => handleTouchEnd('right', e)}
            onTouchCancel={(e) => handleTouchEnd('right', e)}
            onMouseDown={() => triggerInput('right', 'down')}
            onMouseUp={() => triggerInput('right', 'up')}
            onMouseLeave={() => triggerInput('right', 'up')}
            aria-label="Move Right"
          >
            <svg viewBox="0 0 24 24">
              <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>
          </button>
        </div>
      ) : (
        <div ref={dpadRef} /> /* Empty placeholder so flex-end works properly */
      )}

      {/* 2. Right Actions Cluster (Jump and Combat actions) */}
      <div className="pm-mobile-actions" ref={actionsRef} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        {gameType === 'platformer' ? (
          <div className="pm-mobile-actions-stack">
            {/* Top row for attack actions */}
            <div className="pm-mobile-actions-row">
              {projectilesEnabled && (
                <button
                  className="pm-touch-btn"
                  onTouchStart={(e) => handleTouchStart('shoot', e)}
                  onTouchEnd={(e) => handleTouchEnd('shoot', e)}
                  onMouseDown={() => triggerInput('shoot', 'down')}
                  aria-label="Shoot"
                >
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none"/>
                    <circle cx="12" cy="12" r="3" fill="currentColor"/>
                    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="2"/>
                  </svg>
                </button>
              )}

              <button
                className="pm-touch-btn"
                onTouchStart={(e) => handleTouchStart('melee', e)}
                onTouchEnd={(e) => handleTouchEnd('melee', e)}
                onMouseDown={() => triggerInput('melee', 'down')}
                aria-label="Melee Attack"
              >
                <svg viewBox="0 0 24 24">
                  <path d="M19.07 4.93a1 1 0 0 0-1.41 0L12 10.59 7.41 6 6 7.41l4.59 4.59-5.66 5.66A2 2 0 0 0 4.5 19.5l3.54-3.54 1.41 1.41-3.54 3.54a2 2 0 0 0 1.84-.42l5.66-5.66L18 19.41 19.41 18l-4.59-4.59 5.66-5.66a1 1 0 0 0 0-1.41l-1.41-1.41z"/>
                </svg>
              </button>
            </div>

            {/* Bottom row for main jump button */}
            <button
              className="pm-touch-btn pm-touch-btn--jump"
              onTouchStart={(e) => handleTouchStart('jump', e)}
              onTouchEnd={(e) => handleTouchEnd('jump', e)}
              onMouseDown={() => triggerInput('jump', 'down')}
              aria-label="Jump"
            >
              <svg viewBox="0 0 24 24">
                <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>
              </svg>
            </button>
          </div>
        ) : (
          /* Runner Mode action cluster: simple jump button */
          <button
            className="pm-touch-btn pm-touch-btn--jump"
            onTouchStart={(e) => handleTouchStart('jump', e)}
            onTouchEnd={(e) => handleTouchEnd('jump', e)}
            onMouseDown={() => triggerInput('jump', 'down')}
            aria-label="Jump"
          >
            <svg viewBox="0 0 24 24">
              <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};

export default MobileControls;
