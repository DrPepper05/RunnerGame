# CLAUDE.md

Context for AI assistants working in this repo. Everything here was verified against the
code on 2026-07-20 (updated the same day after the asset-pipeline rebuild). If you change
the pipeline, update this file in the same commit.

## What this is

PlayMint — a React + Phaser 3 app (Vite) that turns a text prompt into a playable browser
game. Two game modes: **Runner** and **Platformer** (referred to as "Action Quest" in UI copy).

## The generation pipeline

```
user prompt
  └─> generateGameConfig()          src/game/geminiService.js — LOCAL, no API call
        ├─ parsePromptKeywords()    src/game/promptUtils.js   — theme/mode/modifier matching
        ├─ generateAssetDirections() assetPipeline/promptDesigner.js — theme subject tables
        └─ compileFallbackUrls()    assetPipeline/pipeline.js — raw Pollinations URLs
              └─> config.dynamicAssetUrls   (also the "dynamic asset mode" flag — see below)
  └─> generateGameAssets()          src/game/assetPipeline/pipeline.js — ALL UI paths
        ├─ designAssetPrompts()     promptDesigner.js — ONE LLM JSON call for the style
        │                           guide + subjects: gemini-flash-latest when configured,
        │                           else Pollinations text 'openai-fast' attempt (currently
        │                           402-paywalled — see proxy section); fallback is local
        │                           and PROMPT-FIRST: prompt drives subjects, matched
        │                           theme contributes only palette/mood
        ├─ per slot: Gemini image (gemini-2.5-flash-image, aspectRatio control, 2×retry)
        │            → Pollinations fallback (free/keyless, retries)
        ├─ postProcessAsset()       postprocess.js — resize → flood-key → edge chain
        │                           (erode AA fringe → dark outline → alpha-bleed) →
        │                           darken (mid/near depth grading) → trim/crop
        ├─ keying self-check        deterministic, all providers: border-band near-white
        │                           residue or ~zero keying → one looser re-key
        ├─ vision QA (qa.js)        player/enemy: {facingRight, backgroundClean} →
        │                           mirror client-side / re-key / one regen; never fatal
        ├─ player_sheet: STATIC player generated FIRST (full slot pipeline), then
        │                           the sheet — on Gemini as an image-EDIT call with
        │                           the static sprite as inlineData reference
        │                           ("redraw THIS character in 9 poses"; free path
        │                           asks for a 2×2 4-frame stride instead) → per-cell
        │                           key+re-key → per-frame scoring (geometry +
        │                           color-histogram identity), ≤2 bad run frames
        │                           CULLED to a 1×N strip → align (center-x, shared
        │                           baseline, capped height norm) → union-crop →
        │                           reassemble; Gemini rung escalates to per-frame
        │                           generation (≤10 image-edits of the reference)
        │                           when the grid sheet fails; any terminal failure
        │                           keeps the static base (already registered)
        └─> preloadedImages: { slot: HTMLImageElement } + assetMeta
              └─> GameManagerScene.init() registers as dyn_* textures
                  (addSpriteSheet when assetMeta.slots.player.frames is present)
```

**Slots** (SLOT_SPECS): baseline 6 (`background_far, floor, platform, player, enemy,
obstacle`) + optional parallax `background_mid`/`background_near` (GENERATED_SLOTS) +
`player_sheet` (ALWAYS substituted for `player`; output stored under the `player` key;
falls back to static `player` when the sheet gates reject) + `projectile` (platformer
runs only, optional — dropped on failure, game keeps the static SVG bolt; PlatformerMode
`shoot()` prefers `dyn_projectile` scaled to ~44px width). Optional layers are transparency-gated (≥15% after keying) and DROPPED
with `meta.dropped` on failure — never fatal; `createBackgroundLayers` filters by
`textures.exists`.

### Key design rules

- **Platform art must exactly fill its canvas** (`post.fillAfterCrop`): the game tiles
  `dyn_platform` into a fixed 64×32 physics box, so a cropped-to-content texture of
  arbitrary size makes visuals drift from the hitbox. Crop → stretch back to 128×64.
  `geminiService` defaults `actionProjectileEnabled: true` (prompt-path platformers
  were shipping without their ranged attack).
- **`slotSpecs.js` is the single source of truth** for the 6 slots (`background_far, floor,
  platform, player, enemy, obstacle`): canvas sizes, aspect ratios, post-process flags,
  texture keys, and prompt scaffolds. Do not hardcode slot data elsewhere.
- **Code owns invariants, the LLM owns flavor.** Scaffolds append the non-negotiable prompt
  constraints (pure white background for keyed sprites, facing right, tileable floor,
  framing). The prompt designer only returns subject descriptors + palette.
- **Post-processing is the dimension guarantee.** No provider honors exact pixels and none
  outputs alpha; `postprocess.js` produces the exact contract the game needs. Keying is
  **border-connected flood fill** seeded from the DOMINANT border color (`removeBorderBackground`)
  — handles non-white backdrops and keeps white pixels inside sprites; the old global
  white-threshold keyer survives only as its safety fallback. The dominant-color (not mean)
  detail matters: content flush against one edge (silhouette layers) would drag a mean to
  gray and key nothing. Gemini generates at 16:9/1:1 and gets cover-cropped (no 2:1 option).
- **Vision QA is corrective, never fatal.** `qa.js` reviews the final keyed player/enemy
  (and sheet); wrong facing → client-side mirror; dirty background → looser re-key, then
  one regeneration; any QA error → proceed unverified. Parallax layers (`qa: {clean}`)
  get their own review kind ('layer', `cutoutShapes`): their failure mode is rectangular
  vignette "props" (mini paintings) that pass every transparency gate; a false verdict
  feeds the optional-slot retry-then-drop ladder in runSlot, so a hopeless layer is
  DROPPED rather than shipped as floating picture panels. `assetMeta.slots.*.facingVerified`
  feeds `knownFacing` into SpriteAlignmentManager so its pixel-density facing heuristic
  (which misfires on unusual silhouettes) is overridden for verified sprites. QA is
  gated ONLY on `isGeminiConfigured()` — NOT on `runState.skipGemini`, which tracks the
  image model's quota; the vision model's quota is separate, and QA matters most exactly
  when images fell back to the free provider.
- **Edge chain fixes what keying can't.** Two halo sources survive a perfect key: the
  ring of anti-aliased pixels blended with the white backdrop ("not white enough" for
  the flood), and WebGL bilinear filtering sampling the RGB of adjacent TRANSPARENT
  pixels (which keying leaves white) at render time. `cleanKeyedEdges` runs after every
  keying pass: `erodeAlphaEdge` (spec `post.edgeErode`, sprites 1px / layers 2px) →
  `addOutline` (spec `post.outline` — dark ring under player/enemy/obstacle/platform
  and sheet cells; the pixel-art readability guarantee) → `bleedEdgeColors` (extends
  sprite RGB into transparent neighbors so the filter has nothing white to sample).
  Do not "simplify" the bleed away — the mask can be perfect and the halo still renders.
- **Readability is enforced per category, not per prompt.** `buildFinalPrompt` styles
  slots in buckets: gameplay (player/enemy/obstacle) get the designer's `accentPalette`
  (complementary saturated hue, required schema field; per-theme `THEME_ACCENTS` on the
  local path) — backgrounds get muted/hazy palette language — mid/near get near-black
  silhouette language plus programmatic `post.darken` (0.85/0.72) for atmospheric
  depth. One shared style string was the root cause of everything converging on one hue.
- **Deterministic keying self-check (`enforceKeyQuality`)** runs for every KEYED slot on
  every provider, before vision QA and with no API. Cropped sprites: near-white border
  residue (>6%) or near-zero keying (<5% transparent) → one LOOSER re-key; a >92%
  transparent cropped sprite (flood ate the interior) → one TIGHTER re-key
  ({seedTol:26, stepTol:10}). Non-cropped keyed slots are the parallax layers: their
  contract is an empty top band, so `topBandOpaqueFraction` (>10% of the top 45%) →
  looser re-key, and `checkTransparency` also fails a layer whose top band stays >35%
  opaque ("painted sky") → strict-prompt retry → drop. Every retry is kept only if it
  measurably improves without dissolving the art. The `'flood+white'` secondary white
  pass runs strict (threshold 236/248) with a dissolve guard (reverts if it removed
  >20% of what the flood kept) — the old default-threshold pass ate light prop details.
- **Platform art is column-solidified** (`post.solidify` → `solidifyColumns`): each
  column's opaque span is stretched to full frame height with solid alpha, so the
  texture edge IS the collision edge. `fillAfterCrop` alone only guarantees the
  bounding box touches the frame — rounded "pill" art still read as floating off its
  64×32 hitbox.
- **Arcade `setSize`/`setOffset` take UNSCALED frame pixels** — the body scales with the
  sprite automatically. `SpriteAlignmentManager.optimizeCollisionBox` used to pass
  pre-scaled values, double-scaling the body (a 0.58× player got a 0.33× body) so
  physics rested a shrunken box on the floor and the sprite's legs rendered inside the
  ground. Same unit-mixing existed in `alignToGround`. Both fixed 2026-07-22.
- **No theme defaults to 'ice' anymore.** Prompts matching none of the 5 predefined
  themes get `themeKey: null` → `generateAssetDirections` builds custom directions from
  the prompt text, and `generateTitle` builds the title from the prompt's own words
  (a "clockwork castle" game is never called "Hoarfrost Path" again). ScreenZero's
  banned-word filter is whole-word (`\b`) — the old substring check silently swapped
  innocent prompts ("brASS automaton") for a random ice game.
- **Sprite-sheet frames are ALIGNED per frame, then union-cropped** (`alignFrames` in
  postprocess.js): each frame's content bbox is centered horizontally and bottom-anchored
  to a shared baseline, run-frame heights pulled toward the median (>5% deviation only,
  clamped ±20%) — this removes the model's per-cell drift, which WAS the main
  "animation not continuous" complaint; the union crop (alpha≥16, so one stray pixel
  can't inflate the box) then keeps a common frame box. Never crop per-frame to
  content — that reintroduces jitter. Sheets are mirrored per-frame (whole-sheet mirror
  would swap cell order), transparency-gated ≥30%, and each cell gets its own
  key-quality pass (`keyCellWithQuality`: one tighter/looser re-key on shredded/residue
  cells — prevents per-frame background flicker). Gating is per-frame, not
  all-or-nothing: `evaluateAndCullCells` scores every run frame (geometry: empty or
  <30% cell height; identity: 4×4×4 color-histogram L1 >0.9 vs the run-median) and
  CULLS up to 2 bad run frames into a 1×N strip (`framesMeta {cols:N, rows:1, ...}`,
  jump dropped → `jumpFrameIndex` omitted, `playPlayerAnim` falls back to frame 1);
  ≥3 bad or <4 survivors rejects. Survivors re-checked for staticness
  (`framesLookStatic`) and height ratio ≤1.35. Sheets walk the normal provider ladder:
  Gemini is reliable; Pollinations (sana) gets ONE gated attempt with no regeneration.
- **`config.dynamicAssetUrls` truthiness** is still the switch that routes every Phaser
  consumer between AI (`dyn_*`) and static-theme textures. It also serves as last-ditch
  raw URLs for paths with no preloading (`#config=` share links, initial preset) — Phaser's
  loader fetches them directly in `GameManagerScene.preload()`. BUT: `preload()`
  auto-compiles those URLs only when the key is `undefined`; an EXPLICIT `null` means
  "pipeline failed, UI chose the static-theme downgrade" and must never trigger raw
  Pollinations fetches (they bypass the serial queue → 429s).
- **Generation never dead-ends.** The pipeline no longer dispatches `playmint-error`
  on a failed required slot — it just rejects, and every caller handles it: all four
  ScreenZero paths (preset, prompt, both overlay branches) downgrade via
  `toStaticThemeConfig` (keeps the config, valid `themeKey` or `'ice'`,
  `dynamicAssetUrls: null`) and boot the game on built-in theme art with a terminal
  log line; App's regen paths keep their own error surfaces. A failed required slot
  also sets a `fatal` flag so idle workers stop draining the serial queue.
- **The free path is budget-bounded and the bar always moves.** When Gemini can't
  rescue a run (keyless or `runState.skipGemini`), `generateSlotImage` allows 2
  Pollinations attempts instead of 4, the Pollinations request timeout is 45s, and
  optional layers skip the strict-prompt second ladder on the free provider (same
  one-free-path-attempt rule as sheets). Progress is fractional: per-slot partial
  credit (`slotFraction`, attempt ticks + 0.8 once the raw image is in hand) moves
  the bar 75→94, with 95 reserved for the pipeline-complete report. Attempt-1 ticks
  are silent (`text: null` — UI handlers keep the pct, skip the log); retries emit
  visible "attempt N/M" lines. ScreenZero's asset-phase progress handler is
  monotonic (also absorbs the design step's 73-after-75 report).
- `geminiService.js` remains **local-only** (keyword → physics/config/layout, <100ms, no
  network). The filename is historical; the real Gemini calls live in
  `assetPipeline/providers/geminiImage.js`.
- **Attack spawn points use `player.body.center.y`, never `player.y`** — dynamic-asset
  players have origin (0.5, 1) from SpriteAlignmentManager (bottom-center ground
  anchor), so `player.y` is the feet; static themes keep origin (0.5, 0.5). Body center
  is correct on both paths.
- **Creator Panel prompt box routes through `gameEditor.js` first** (when a game is
  running): one `generateJson` call classifies the instruction as `tweak` (variable
  patch), `restyle` (cherry-pick art regeneration), or `regenerate` (brand-new game).
  The LLM proposes, code enforces — only `EDITABLE_FIELDS` survive, every value
  clamped to safe ranges; `assetTargets` filtered against the known target names.
  Tweaks ride the existing slider channel (`setLiveParams` → `update-game-config`
  event → `onConfigUpdate` in the active mode). Restyles call
  `regenerateAssetSlots({config, instruction, slots})` (slots via
  `resolveAssetTargets`; 'foreground'→mid+near, 'all'→everything, projectile only on
  platformers), then App.jsx MERGES the returned images/meta over the retained
  `liveParams.preloadedImages`/`assetMeta.slots` and bumps `gameKey` to remount — a
  dropped redrawn layer keeps its old art. Full re-themes ("lava world") are restyle
  ['all'] BY DESIGN (config/mode/tweaks survive); `regenerate` is only for new game
  concepts. Preset/share-link games (no `preloadedImages`) escalate restyle → full
  regenerate. **Mode switching from the prompt is intentionally unsupported** — the
  editor answers with an explanatory refusal (empty tweak + summary), never a
  regeneration; keyless path has a tight regex for the same refusal.

## Live modules

| File | Role |
|---|---|
| `src/game/assetPipeline/slotSpecs.js` | Slot contract: sizes, scaffolds, texture keys, models |
| `src/game/assetPipeline/pipeline.js` | Orchestrator: `generateGameAssets`, `compileFallbackUrls`, retry/fallback/concurrency(3) |
| `src/game/assetPipeline/promptDesigner.js` | LLM prompt design + local theme tables (`generateAssetDirections`) |
| `src/game/assetPipeline/postprocess.js` | Pure canvas: resize, flood-key, trim, crop, sheet slice/assemble |
| `src/game/assetPipeline/qa.js` | Vision QA reviewer (facing/background/grid), never throws |
| `src/game/assetPipeline/providers/geminiImage.js` | @google/genai image+JSON calls, ProviderError taxonomy |
| `src/game/assetPipeline/providers/pollinations.js` | Free fallback: URL builder + fetch→dataURL |
| `src/game/geminiService.js` | Local config gen (physics/layout/title) — misnamed, no API |
| `src/game/gameEditor.js` | AI live editor for the Creator Panel prompt box: `interpretEditPrompt(config, instruction)` → tweak (clamped whitelist patch, no reboot) / restyle (`assetTargets` → `resolveAssetTargets` → partial pipeline + merge-and-remount) / regenerate (full pipeline); mode-switch refusal; local keyword fallback without a key |
| `src/game/promptUtils.js` | Keyword parsing, title gen, procedural layout, tuning table |
| `src/game/GameManagerScene.js` | Main Phaser scene; registers preloadedImages as `dyn_*` |
| `src/game/GameModeManager.js` | Mode dispatch → `modes/RunnerMode.js`, `modes/PlatformerMode.js` |
| `src/game/ParallaxGroundSystem.js` | Multi-layer scrolling background (initialize() unused on dynamic path) |
| `src/game/SpriteAlignmentManager.js` | Ground-contact alignment; reads texture pixels (data URLs keep canvases untainted) |
| `src/game/themes.js` / `src/gameConfig.js` | Static theme assets, `GAME_PRESETS`, `DEFAULT_CONFIG` |

## Commands

```bash
npm run dev      # Vite dev server — the only dev command (no separate proxy process)
npm run build
npm run lint
```

### Pollinations proxy (built into Vite)

Pollinations blocks browser cross-origin requests with Cloudflare Turnstile ("Missing
Turnstile token"), so the client always calls same-origin `/api/pollinations/*` and
`vite.config.js` proxies it to `https://image.pollinations.ai` (dev and preview servers).
A production host needs an equivalent rewrite rule — `vercel.json` provides it for the
Vercel deployment (playmintai.vercel.app); without it EVERY free-path request 404s in
production and generation can only downgrade (found the hard way 2026-07-30). A raw-URL
boot (share link / preset, no preloadedImages) whose `dyn_*` loads all fail is caught in
`GameManagerScene.create()`: missing required dyn textures → `dynamicAssetUrls = null` →
built-in theme art, and `loaderror` on `dyn_*` keys no longer raises the fatal error
dialog (create()'s downgrade handles it). Two more Pollinations facts learned
the hard way (all handled in `providers/pollinations.js`):
- Auth is the **`token`** query param — the legacy `key` param is silently ignored,
  leaving requests on the heavily rate-limited anonymous tier.
- Only ~one generation may be in flight at a time; extra concurrent requests 429. All
  calls run through a strict serial queue (request completes → gap → next), so a full
  free-path generation takes ~3–8 minutes depending on Pollinations load (requests are capped at 45s each and the
  keyless attempt budget is 2 per slot — see "budget-bounded" above).
- This token tier exposes exactly ONE image model (`sana` — `/models` returns
  `["sana"]`); `model=`/`transparent=`/`gptimage` params are ignored or unavailable, and
  the text tier has only `openai-fast` with NO vision — so free-path QA must be local
  (geometry gates, residue checks), not model-based. When Gemini is off,
  `designAssetPrompts` first attempts the design step on the text tier via
  `/api/pollinations-text` (`generateDesignJson` in providers/pollinations.js — NOT
  routed through the image serial queue; different upstream, runs before images start;
  `design.source: 'free-llm'`). **BUT as of 2026-07-31 text.pollinations.ai returns
  402 for everything nontrivial** (anonymous AND token — "pollen" credit paywall;
  `jsonMode`/POST/referrer all verified 402), so this attempt fails fast (<1s) and
  exists as self-healing wiring. The fidelity guarantee is therefore LOCAL:
  `generateAssetDirections` is prompt-first — a non-empty prompt always builds
  subjects from the prompt text (matched theme contributes only palette + mood);
  canned theme tables apply ONLY to promptless runs (presets/quick start). Do not
  restore theme-table precedence: "on-theme but off-prompt" assets were a client
  complaint (2026-07-31). Sana responds strongly to
  front-loaded pose language ("mid-run stride") and needs "no ground, no motion lines"
  to suppress baked-in floor streaks.

## Environment

`.env` is gitignored and holds live keys — never commit it, never paste its values into
output. `.env.example` is the tracked template.

- `VITE_GEMINI_API_KEY` — recommended. Enables Gemini asset generation + prompt design.
  Mirrored to localStorage on startup (`App.jsx`); also settable via the UI key buttons
  (ScreenZero, CreatorPanel). **Client-side by design** — accepted tradeoff for this app.
- `VITE_POLLINATIONS_API_KEY` — optional auth suffix on Pollinations URLs.
- Without any key the app still works: Pollinations fallback, local prompt templates.
- **Provider selection is three-state** (`isGeminiConfigured`, providers/geminiImage.js):
  `localStorage.PM_FORCE_POLLINATIONS` — written by the ScreenZero top-right Provider
  dropdown — is authoritative when set: `'1'` forces the free path, `'0'` forces Gemini
  (overriding the env flag, since Vite inlines env at build and it can't be unset at
  runtime). Only when the key is absent (user never touched the toggle) does
  `VITE_FORCE_POLLINATIONS=1` decide. ScreenZero's dropdown init mirrors this exact
  logic — keep them in sync or the UI lies about the active provider.
- `VITE_FORCE_POLLINATIONS=1` — env-level default for the free path (client evaluation
  mode). Currently ON in the local `.env` per the client's 2026-07-24 request; the UI
  toggle can now override it per-browser without a restart.
- Forcing Pollinations disables ALL Gemini calls (images, prompt designer, vision QA,
  Creator-Panel editor LLM) — `isGeminiConfigured()` is the single gate. "Gemini" mode
  is gemini-PRIMARY: per-slot fallback to Pollinations on failure/quota still applies.

## Parallax + animation (implemented 2026-07-20, phase 2)

- Dynamic backgrounds: the FAR layer is a classic cover-scaled sprite (a panorama can't
  wrap without visible seams — do NOT make it a tileSprite). MID (heightFrac 0.55) and
  NEAR (0.35) are **wrapping tileSprite strips whose BOTTOM is pinned to the ground line**
  — for scrollFactor-0 objects the screen-equivalent of a world Y is
  `LOGICAL_FLOOR_Y - camera.scrollY`, re-applied every frame in `update()` (exact under
  any camera zoom/scroll, both modes). Strips are exactly one texture-height tall (no
  vertical wrap), scrolled via `tilePositionX` (runner uses `virtualScrollX`). Layers
  filter by `textures.exists`. `handleResize` has a dedicated `__isParallaxTile` branch
  (`setScale` on a TileSprite scales the footprint, not the tiles). Textures are POT
  (1024×512) — required for WebGL tileSprite wrap. Mid/near use `keying: 'flood+white'`
  — flood alone keeps white pockets ENCLOSED between silhouette shapes.
- **Under-floor fill**: `createFloorFill` adds a darkened tileSprite from the floor's
  bottom edge 1000px down so the floor never ends in empty space above the viewport
  border. Visual only — collision (`this.floor`) untouched. In runner mode its
  `tilePositionX` tracks `virtualScrollX` so the pattern doesn't slide against the
  moving floor segments; resized alongside the floor in `handleResize`.
- The player is a generated **spritesheet** whenever a provider delivers frames that
  pass the gates: on Gemini a 3×3 (cells 0-7 an 8-frame run cycle with alternating
  legs, cell 8 a dedicated jump pose); on the free path a **2×2 4-frame stride**
  (`player_sheet.freeVariant`: 512×512, poses contact-R/pass/contact-L/pass =
  RUN_CYCLE_POSES[0,1,4,5], `jumpFrameIndex: 1` — the pass pose doubles as the jump
  frame, there is no dedicated jump cell). The variant follows `isGeminiConfigured()`
  AT RUN START only — a mid-run `skipGemini` flip must NOT switch specs, the prompt
  was already built for the other grid (`buildFinalPrompt {free}` and `runSheetSlot`
  `activeSpec` share this rule). Spec `frames: {cols, rows, runFrameCount,
  jumpFrameIndex}` — the scene reads these from assetMeta, so ANY grid or 1×N strip
  needs no scene edits. **`runSheetSlot` generates the STATIC player first** (full
  slot pipeline: keying, QA, facing correction), then the sheet: on the Gemini rung
  the sheet request is an image-EDIT call with the static sprite attached as
  inlineData reference ("redraw THIS EXACT character") — single-shot "draw the same
  character 9 times" was the root cause of a different-looking character per cell.
  Pose choreography lives in ONE place: `RUN_CYCLE_POSES`/`JUMP_POSE` in slotSpecs.js
  (used by both scaffolds AND the per-frame escalation prompts). The scaffolds lead
  with IDENTITY ("copied nine/four times, only limb poses redrawn") — do NOT add
  "every cell must differ from every other cell" pressure: a run cycle legitimately
  repeats its passing poses (cells 2/6), and that pressure makes models redesign the
  character per cell (regression observed 2026-07-30). **Gemini escalation rung**
  (`generatePerFrameSheet`): when the grid sheet fails its gates and Gemini is alive,
  each pose is drawn as its OWN image-edit of the reference (worker pool 3, hard cap
  10 calls, 1 shared retry; dead quota/auth aborts and sets `skipGemini`), keyed as
  cells, scored/culled the same way (≥4 run frames must survive), assembled as a 1×N
  strip, one vision call for facing only — `meta.player.perFrame: true`. Sheet
  failure keeps the already-registered static base; sheet success overwrites the
  player image+meta WITHOUT a second doneCount increment. Gates are per-frame
  (`evaluateAndCullCells` — see the design-rules bullet). Vision guards (Gemini grid
  sheets): `gridConsistent`, `legsAlternate`. Registered via `addSpriteSheet`,
  animated as `dyn_player_run` (frameRate 12 @ ≥8 frames, 10 @ 6-7, 8 @ 4-5);
  `playPlayerAnim`: run → cycle, idle → frame 0, jump → `jumpFrameIndex ?? 1`.
  **Sheets are keyed PER CELL** (`processSheet`: slice with a 3px inset →
  `keyCellWithQuality` each cell) — a whole-sheet flood can never reach an interior
  cell's backdrop (3×3 center), and the inset discards model-drawn grid lines. One
  regeneration for any quality failure (then per-frame escalation on Gemini, then
  static base) — except on the Pollinations rung, which never regenerates (one
  serial-queue slot max; the free path always spends 2 serialized calls on the
  player: static then sheet attempt).
- Static dynamic players (sheet gates rejected / free path) get a **procedural run bob**
  (`startPlayerBob`/`stopPlayerBob` in GameManagerScene: ±3° angle tween, 110ms yoyo) so
  the player never looks frozen; idle/jump reset the angle to 0.

## Deferred roadmap (designed, not implemented)

- **Enemy animation**: reuse the `player_sheet` machinery (spec + `finalizeSheetFrames`
  + `addSpriteSheet` branch) for an `enemy_sheet` slot. An enemy_sheet gets the
  reference-edit call, per-frame alignment/culling AND the per-frame Gemini
  escalation for free via runSheetSlot — it needs its own pose table (walk/skitter,
  not a human run cycle).

(The 4-frame free-path 2×2 cycle from this list was IMPLEMENTED 2026-07-31 —
see the player-sheet bullet above.)

## Notes for AI assistants

- This repo previously accumulated confidently-written markdown docs that contradicted the
  code. They were deleted on 2026-07-20 along with ~1,676 lines of unreachable code, and the
  SEELE-based orchestration (AssetOrchestrator.js, seele-proxy.js) was later replaced by
  `src/game/assetPipeline/`. **Verify against source before trusting any doc, including
  this one.**
- `AI_ORCHESTRATION_STATUS.md` documents the current pipeline state + the pre-rebuild
  history and the author's original notes.
- There is no test suite. `npm run build` and `npm run lint` are the only checks.
- `npm run lint` baseline: **~50 errors in `src/`** (mostly `no-unused-vars` and empty
  `catch {}` blocks; was ~62 before the rebuild deleted dead code). Don't add to it.
  `eslint.config.js` ignores `dist`, `import`, `scratch`, and `generated_test_assets`;
  `import/` is vendored third-party Phaser demo code.
- Root-level SEELE experiment scripts live in `scratch/seele-experiments/` (gitignored).
  They target the deleted SEELE integration and are historical.
- `import/` is vendored sample projects (Phaser demos, `.zip`, `__MACOSX` cruft). Not the
  app. The app is `src/` plus `index.html` and `vite.config.js`.
