// Bulk cache population (added 2026-08-14): generates a curated list of theme
// sets through the REAL pipeline (post-processing, tagging, IndexedDB, Blob
// upload) so the shared cache has a starting population for every user.
//
// Run from the deployed site's DevTools console:
//   __PM_BULK()                          // defaults: 40 prompts + 2 presets,
//                                        // playerless, $10 hard budget abort
//   __PM_BULK(null, { budgetUsd: 5 })    // tighter budget
//   __PM_BULK(['lava runner with imps']) // custom list
//
// Properties: RESUMABLE at $0 (each item is skipped when its prompt key already
// exists locally OR in the server population — works across browsers); hard
// budget abort (everything generated so far stays cached/uploaded); stops on
// dead quota/auth or 2 consecutive failures; per-set cost/timing table + a
// downloadable report with the cache-hit-rate pricing projection.
//
// Population sets are PLAYERLESS by default (skipSlots: ['player']) — the scene
// falls back to the theme player, and the matcher auto-completes a static player
// (~$0.03) on a set's first real keyed use.

import { generateGameConfig } from '../geminiService.js';
import { generateTitle } from '../promptUtils.js';
import { GAME_PRESETS } from '../../gameConfig.js';
import { generateAndCache, makePromptKey, makePresetKey } from './index.js';
import * as backend from './idbBackend.js';
import * as server from './serverBackend.js';

// 24 runners + 16 platformer quests, curated for spread: every prompt carries a
// mode word, a distinct world, and named entities (binding + tags). Near-dupes
// are avoided on purpose — bulk skips only on EXACT key, so curation is the dedup.
export const DEFAULT_BULK_PROMPTS = [
  // Runners
  'ice kingdom runner with frost wolf enemies and crystal shards',
  'lava volcano dash with magma golem enemies and obsidian spikes',
  'enchanted forest run with thorn hazards and glowing acorn pickups',
  'neon cyberpunk city sprint with security drone enemies and data coins',
  'deep space station runner with alien blob enemies and energy cells',
  'haunted graveyard dash with ghost enemies and skull token pickups',
  'underwater coral reef runner with pufferfish enemies and pearl pickups',
  'desert canyon run with scorpion enemies, cactus spikes and gold nuggets',
  'candy land dash with gummy bear enemies and lollipop coin pickups',
  'pirate cove runner with crab enemies, wooden spikes and doubloon coins',
  'steampunk factory run with clockwork robot enemies and brass gear pickups',
  'sky cloud kingdom dash with storm imp enemies and star fragments',
  'ancient jungle temple runner with snake enemies and jade idol pickups',
  'medieval castle run with knight enemies and ruby gem pickups',
  'autumn forest dash with wild boar enemies, thorn traps and golden leaves',
  'arctic glacier sprint with yeti enemies, icicle spikes and frozen gems',
  'wild west desert runner with bandit enemies and sheriff badge pickups',
  'swamp bayou dash with toad monster enemies and emerald orb pickups',
  'cherry blossom garden run with oni spirit enemies and sakura petal pickups',
  'crystal cavern runner with rock golem enemies and amethyst pickups',
  'volcanic island dash with fire bat enemies and molten coin pickups',
  'midnight rooftop city run with shadow cat enemies and neon shard pickups',
  'dinosaur jungle runner with raptor enemies and amber stone pickups',
  'blizzard mountain run with snow leopard enemies and silver coins',
  // Platformer quests
  'lava temple action quest with fire demon enemies and ruby gem pickups',
  'ice palace platformer quest with frost giant enemies and diamond shards',
  'dark dungeon action quest with skeleton enemies, bone spikes and gold coins',
  'mystic forest quest with goblin enemies and enchanted acorn pickups',
  'cyber city action platformer with rogue android enemies and chip tokens',
  'space colony quest with alien crawler enemies and plasma core pickups',
  'sunken shipwreck action quest with zombie pirate enemies and treasure coins',
  'desert pyramid platformer with mummy enemies and scarab amulet pickups',
  'candy castle quest with licorice spider enemies and sugar crystal pickups',
  'sky fortress action quest with harpy enemies and cloud orb pickups',
  'steampunk airship platformer with gear drone enemies and copper cog pickups',
  'haunted mansion action quest with phantom enemies and cursed coin pickups',
  'jungle ruins platformer quest with stone guardian enemies and emerald idols',
  'frozen fortress action quest with ice wraith enemies and frost crystals',
  'underworld cavern quest with lava serpent enemies and onyx gem pickups',
  'toybox workshop action platformer with windup soldier enemies and button coins'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isDeadProvider = (err) =>
  err?.kind === 'quota' || err?.kind === 'auth' ||
  /quota|exhausted|api key|permission/i.test(err?.message || '');

// Preset entries mirror ScreenZero.generateRandom (difficulty is irrelevant to
// the preset key — it re-randomizes on every hit; only the art matters).
const presetItems = () => ['standard', 'action_quest'].map((mode) => ({
  label: `preset:${mode}`,
  userPrompt: '',
  buildConfig: async () => ({
    ...GAME_PRESETS[mode],
    themeKey: 'ice',
    gameName: generateTitle('', mode, 'ice'),
    dynamicAssetUrls: true
  }),
  promptKeyFor: () => makePresetKey(mode)
}));

const promptItems = (prompts) => prompts.map((prompt) => ({
  label: prompt,
  userPrompt: prompt,
  buildConfig: async () => (await generateGameConfig(prompt, () => {})).config,
  promptKeyFor: (config) => makePromptKey(prompt, config.gameType)
}));

const downloadReport = (text) => {
  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `playmint-bulk-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { /* report stays in the console */ }
};

const projectionTable = (fullGenAvg) =>
  [0, 0.25, 0.5, 0.75, 0.9].map((h) => {
    const avg = h * 0.001 + (1 - h) * fullGenAvg;
    return `  ${String(h * 100).padStart(3)}% cache hit rate → avg $${avg.toFixed(3)} per generation`;
  }).join('\n');

export async function runBulkPopulation(list = null, opts = {}) {
  const {
    budgetUsd = 10,
    skipSlots = ['player'],
    delayMs = 2000,
    includePresets = true
  } = opts;

  const items = [
    ...(includePresets ? presetItems() : []),
    ...promptItems(list || DEFAULT_BULK_PROMPTS)
  ];

  // Server population keys, for cross-browser resume.
  const serverKeys = new Set((await server.listGames()).map((c) => c.promptKey).filter(Boolean));

  const perSet = [];
  let totalEstUsd = 0;
  let consecutiveFailures = 0;
  let aborted = null;

  console.log(`[BULK] ${items.length} item(s), budget $${budgetUsd}, skipSlots: [${skipSlots.join(', ')}]`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const t0 = performance.now();
    try {
      const config = await item.buildConfig();
      const promptKey = item.promptKeyFor(config);

      if (serverKeys.has(promptKey) || await backend.findByPromptKey(promptKey)) {
        perSet.push({ n: i + 1, prompt: item.label, status: 'skipped (cached)', images: 0, estUsd: 0, secs: 0 });
        console.log(`[BULK] ${i + 1}/${items.length} SKIP (already cached): ${item.label}`);
        continue;
      }
      if (totalEstUsd >= budgetUsd) {
        aborted = `budget cap $${budgetUsd} reached`;
        break;
      }

      console.log(`[BULK] ${i + 1}/${items.length} generating: ${item.label}`);
      const result = await generateAndCache({
        config: { ...config, dynamicAssetUrls: true },
        userPrompt: item.userPrompt,
        promptKey,
        skipSlots,
        awaitPersist: true, // Blob upload must land before the LRU can evict
        trackStats: false, // population runs must not pollute the user hit-rate stats
        onProgress: (text) => { if (text) console.log(`   ${text}`); }
      });
      const estUsd = result.assetMeta?.cost?.estUsd || 0;
      const images = Object.keys(result.preloadedImages || {}).length;
      totalEstUsd += estUsd;
      consecutiveFailures = 0;
      const secs = Math.round((performance.now() - t0) / 1000);
      perSet.push({ n: i + 1, prompt: item.label, status: 'generated', images, estUsd, secs });
      console.log(`[BULK] ✓ ${images} image(s), ≈$${estUsd.toFixed(3)}, ${secs}s — running total ≈$${totalEstUsd.toFixed(2)}`);
      if (delayMs) await sleep(delayMs);
    } catch (err) {
      consecutiveFailures += 1;
      perSet.push({ n: i + 1, prompt: item.label, status: `FAILED: ${err?.message}`, images: 0, estUsd: 0, secs: Math.round((performance.now() - t0) / 1000) });
      console.warn(`[BULK] ✗ ${item.label}:`, err?.message || err);
      if (isDeadProvider(err)) { aborted = `provider dead (${err?.kind || 'quota/auth'})`; break; }
      if (consecutiveFailures >= 2) { aborted = '2 consecutive failures'; break; }
    }
  }

  const generated = perSet.filter((s) => s.status === 'generated');
  const skipped = perSet.filter((s) => s.status.startsWith('skipped'));
  const failed = perSet.filter((s) => s.status.startsWith('FAILED'));
  // Organic prompts still generate WITH player+sheet; ~$0.33 assumes the combined
  // props call (default ON) + the lite player + the 2.5 sheet — the pre-flip
  // individual-call pipeline measured ~$0.55.
  const fullGenAvg = 0.33;
  const bulkAvg = generated.length ? totalEstUsd / generated.length : 0;

  const summaryText =
    `PlayMint bulk population — ${new Date().toISOString()}\n` +
    `Items: ${items.length} | generated: ${generated.length} | skipped (already cached): ${skipped.length} | failed: ${failed.length}\n` +
    `Total estimated spend: $${totalEstUsd.toFixed(2)}${aborted ? ` | STOPPED: ${aborted} (resume by re-running — completed sets are skipped for $0)` : ''}\n` +
    `Average per playerless set: $${bulkAvg.toFixed(3)}\n\n` +
    `Pricing projection (avg cost per user generation vs cache hit rate;\n` +
    `full generation with player ≈ $${fullGenAvg.toFixed(2)}, cache hit ≈ $0.001,\n` +
    `partial reuse (1-3 slots redrawn) ≈ $0.03-0.15 lands between):\n` +
    `${projectionTable(fullGenAvg)}\n\n` +
    `Per set:\n` +
    perSet.map((s) => `  #${s.n} [${s.status}] $${s.estUsd.toFixed(3)} ${s.images} img ${s.secs}s — ${s.prompt}`).join('\n') +
    '\n';

  console.table(perSet);
  console.log(summaryText);
  downloadReport(summaryText);
  return { generated: generated.length, skipped: skipped.length, failed: failed.length, totalEstUsd, aborted, perSet };
}
