import React from 'react';

const LOG_COLORS = [
  ['[SYSTEM]', 'var(--pm-accent-teal)'],
  ['[EDITOR]', 'var(--pm-accent-orange)'],
  ['[DESIGN]', '#8A2BE2'],
  ['[ASSETS]', 'var(--pm-accent-orange)'],
  ['[ENGINE]', 'var(--pm-accent-teal)']
];

/**
 * Full-screen progress overlay shown while the Creator Panel prompt regenerates a
 * world in place (the start screen has its own compiler terminal; this is the
 * in-game equivalent). Renders nothing when `state` is null.
 */
const RegenOverlay = ({ state }) => {
  if (!state) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 3000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(4, 7, 12, 0.82)', backdropFilter: 'blur(6px)'
    }}>
      <div className="pm-glass-panel" style={{
        width: 'min(560px, calc(100vw - 32px))',
        borderRadius: '14px', border: '1px solid var(--pm-border)',
        padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#FF5F57' }} />
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#FEBC2E' }} />
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#28C840' }} />
          </div>
          <span style={{ color: 'var(--pm-text-tertiary)', fontSize: '10px', fontWeight: 'bold', letterSpacing: '1px' }}>
            PLAYMINT COMPILER v2.0 — REBUILD
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minHeight: '120px', maxHeight: '180px', overflowY: 'auto' }}>
          {state.logs.map((log, i) => {
            const color = (LOG_COLORS.find(([prefix]) => log.startsWith(prefix)) || [null, '#fff'])[1];
            return (
              <div key={i} style={{
                color, fontSize: '12px', lineHeight: 1.5, textAlign: 'left',
                fontFamily: 'monospace', textShadow: `0 0 6px ${color}40`, whiteSpace: 'pre-wrap'
              }}>
                {log}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--pm-text-secondary)' }}>
            <span>{state.title || 'Regenerating World'}</span>
            <span style={{ color: 'var(--pm-accent-teal)', fontWeight: 'bold' }}>{Math.round(state.progress)}%</span>
          </div>
          <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              width: `${state.progress}%`, height: '100%',
              background: 'linear-gradient(90deg, var(--pm-accent-teal), #8A2BE2)',
              boxShadow: '0 0 8px var(--pm-accent-teal)', borderRadius: '3px',
              transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
            }} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default RegenOverlay;
