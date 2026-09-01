import React from 'react';
import { GAME_PRESETS } from '../gameConfig';

const COMING_SOON_MODES = [
  'RPG Adventure', 'Empire Builder', 'Fighting Arena',
  'Racing Rush', 'Survival Mode', 'Simulator World'
];

const GameSelectorModal = ({ isOpen, presetKey, onSelectPreset, onClose }) => {
  if (!isOpen) return null;

  const handleSelect = (key) => {
    onSelectPreset(key);
    onClose();
  };

  return (
    <div className="gsm-wrapper">
      <style>{`
        .gsm-wrapper {
          position: fixed;
          inset: 0;
          z-index: 11000;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 60px 20px;
          overflow-y: auto;
          overflow-x: hidden;
          background: rgba(11, 14, 20, 0.95);
          backdrop-filter: blur(10px);
          pointer-events: auto;
          box-sizing: border-box;
        }

        .gsm-logo {
          height: 40px;
          margin-bottom: 30px;
        }

        .gsm-title {
          color: #fff;
          font-size: clamp(24px, 5vw, 36px);
          margin: 0 0 40px 0;
          font-family: var(--font-game);
          letter-spacing: 2px;
        }

        .gsm-section {
          max-width: 1000px;
          width: 100%;
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
        }

        .gsm-section-title-active {
          color: var(--pm-accent-teal);
          margin-bottom: 8px;
          font-size: 20px;
          text-align: left;
        }

        .gsm-section-title-soon {
          color: var(--pm-text-secondary);
          border-bottom: 1px solid var(--pm-border);
          padding-bottom: 15px;
          margin-top: 0;
          margin-bottom: 30px;
          font-size: 16px;
          text-align: left;
        }

        .gsm-separator {
          height: 2px;
          background: linear-gradient(90deg, var(--pm-accent-teal) 0%, transparent 100%);
          margin-bottom: 30px;
          width: 100%;
        }

        .gsm-playable-container {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 24px;
          margin-bottom: 50px;
        }

        .gsm-playable-card {
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 30px 20px;
          box-sizing: border-box;
          transition: all 0.2s ease;
        }

        .gsm-coming-soon-container {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 16px;
        }

        .gsm-coming-soon-card {
          padding: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          opacity: 0.5;
          box-sizing: border-box;
        }

        .gsm-coming-soon-name {
          font-size: 14px;
          font-weight: 500;
        }

        .gsm-cancel-btn {
          margin-top: 50px;
          outline: none;
        }

        /* Portrait & landscape mobile optimizations (< 640px) */
        @media (max-width: 640px) {
          .gsm-wrapper {
            padding: 20px 16px;
            justify-content: space-between;
          }
          .gsm-logo {
            height: 24px;
            margin-bottom: 12px;
          }
          .gsm-title {
            font-size: 20px;
            margin: 0 0 16px 0;
          }
          .gsm-section-title-active {
            font-size: 14px;
            margin-bottom: 4px;
            margin-top: 0;
          }
          .gsm-separator {
            margin-bottom: 12px;
          }
          .gsm-playable-container {
            grid-template-columns: 1fr;
            gap: 12px;
            margin-bottom: 24px;
          }
          .gsm-playable-card {
            padding: 20px 16px;
            height: 80px;
          }
          .gsm-playable-card h4 {
            font-size: 13px !important;
          }
          .gsm-section-title-soon {
            font-size: 12px;
            padding-bottom: 6px;
            margin-bottom: 10px;
            margin-top: 4px;
          }
          .gsm-coming-soon-container {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            padding: 8px 4px;
            width: 100%;
          }
          .gsm-coming-soon-card {
            padding: 10px 12px !important;
            height: 48px;
            box-sizing: border-box;
          }
          .gsm-coming-soon-name {
            font-size: 12px !important;
          }
          .gsm-coming-soon-badge {
            font-size: 8px !important;
            padding: 2px 4px !important;
          }
          .gsm-cancel-btn {
            margin-top: 16px;
            height: 38px;
            padding: 4px 20px;
            font-size: 12px;
          }
        }

        /* Extra landscape mobile viewports with low height */
        @media (max-height: 520px) and (max-width: 900px) {
          .gsm-wrapper {
            padding: 12px 24px;
          }
          .gsm-logo {
            display: none;
          }
          .gsm-title {
            font-size: 18px;
            margin: 0 0 8px 0;
          }
          .gsm-section-title-active {
            display: none;
          }
          .gsm-separator {
            display: none;
          }
          .gsm-playable-container {
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 8px;
          }
          .gsm-playable-card {
            padding: 10px;
            height: 48px;
          }
          .gsm-playable-card h4 {
            font-size: 14px !important;
          }
          .gsm-section-title-soon {
            display: none;
          }
          .gsm-coming-soon-container {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 8px;
            padding: 4px;
            width: 100%;
          }
          .gsm-coming-soon-card {
            padding: 8px !important;
            height: 38px;
          }
          .gsm-coming-soon-name {
            font-size: 11px !important;
          }
          .gsm-coming-soon-badge {
            display: none !important;
          }
          .gsm-cancel-btn {
            margin-top: 8px;
            padding: 2px 16px;
          }
        }
      `}</style>

      <img src="/assets/Logo_PlayMint_(transparent).png" alt="PlayMint" className="gsm-logo" />
      <h2 className="gsm-title">SELECT MODE</h2>
      
      <div className="gsm-section">
        <h3 className="gsm-section-title-active">Available Now</h3>
        <div className="gsm-separator"></div>
        <div className="gsm-playable-container">
          
          {/* Runner */}
          <div 
            className="pm-card gsm-playable-card"
            onClick={() => handleSelect('standard')}
            style={{ border: presetKey === 'standard' ? '2px solid var(--pm-accent-teal)' : '2px solid transparent', background: 'radial-gradient(circle at bottom left, rgba(33, 155, 134, 0.15), var(--pm-bg-panel-light) 70%)' }}
          >
            <h4 className="pm-heading" style={{ margin: '0', fontSize: '20px' }}>Runner</h4>
          </div>

          {/* Action Quest */}
          <div
            className="pm-card gsm-playable-card"
            onClick={() => handleSelect('action_quest')}
            style={{ border: presetKey === 'action_quest' ? '2px solid var(--pm-accent-teal)' : '2px solid transparent', background: 'radial-gradient(circle at bottom right, rgba(212, 157, 51, 0.15), var(--pm-bg-panel-light) 70%)' }}
          >
            <h4 className="pm-heading" style={{ margin: '0', fontSize: '20px' }}>Action Quest</h4>
          </div>

          {/* Shooter Arena */}
          <div
            className="pm-card gsm-playable-card"
            onClick={() => handleSelect('shooter_arena')}
            style={{ border: presetKey === 'shooter_arena' ? '2px solid var(--pm-accent-teal)' : '2px solid transparent', background: 'radial-gradient(circle at top right, rgba(139, 92, 246, 0.15), var(--pm-bg-panel-light) 70%)' }}
          >
            <h4 className="pm-heading" style={{ margin: '0', fontSize: '20px' }}>Shooter Arena</h4>
          </div>
        </div>

        <h3 className="gsm-section-title-soon">Coming Soon</h3>
        <div className="gsm-coming-soon-container">
          {COMING_SOON_MODES.map(name => (
            <div key={name} className="pm-card gsm-coming-soon-card">
              <span className="gsm-coming-soon-name">{name}</span>
              <span className="pm-badge gsm-coming-soon-badge" style={{ background: 'var(--pm-bg-main)', color: 'var(--pm-text-tertiary)' }}>LOCKED</span>
            </div>
          ))}
        </div>
      </div>
      
      <button 
        className="pm-btn pm-btn-outline gsm-cancel-btn"
        onClick={onClose}
      >
        Cancel
      </button>
    </div>
  );
};

export default GameSelectorModal;
