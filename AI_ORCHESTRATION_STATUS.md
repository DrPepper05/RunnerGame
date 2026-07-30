# AI Asset Generation - Status Report

Updated 2026-07-20 after the from-scratch rebuild. The previous multi-provider
orchestration (SEELE + 4 untested provider classes + CORS proxy) was deleted and replaced
with `src/game/assetPipeline/`.

## Current State

Working. One unified pipeline generates all 6 assets (background, floor, platform, player,
enemy, obstacle) for every UI path:

- **Primary provider:** Gemini (`gemini-2.5-flash-image`) via the official `@google/genai`
  SDK, using `VITE_GEMINI_API_KEY` (or a key entered in the UI, stored in localStorage).
- **Automatic fallback:** Pollinations.ai (free, keyless) whenever Gemini is missing a key,
  hits quota, or errors. The app never hard-fails for lack of a key.
- **Prompt design:** one `gemini-2.5-flash` text call turns the user prompt into a shared
  style guide + six subject descriptors (structured JSON). Falls back to the local theme
  tables on any failure. Invariant constraints (white background, facing right, tileable,
  framing) are appended by code in `slotSpecs.js` — the LLM only supplies flavor.

## How the dimension problem was solved

No provider honors exact pixel dimensions, and none can output transparency. Instead of
fighting that, the pipeline guarantees the contract in post-processing (`postprocess.js`):
resize to per-slot canvas size (16:9 backgrounds center-crop to 1024×512), key out the flat
white generation background (threshold 200/240 with edge blending), then auto-crop sprites
to content so full-texture hitboxes stay fair. Aspect ratio is controlled at generation
time via Gemini's `imageConfig.aspectRatio`.

## Phase 2 (2026-07-20): quality hardening + parallax + animation

- **Flood-fill keying** (dominant-border-color seeded) replaced the global white threshold:
  handles non-white backdrops, keeps white pixels inside sprites, works for layers whose
  content touches an edge.
- **Vision QA** on player/enemy: gemini-flash-latest checks facing + background; wrong
  facing is mirrored client-side, dirty background re-keyed/regenerated once. Verified
  facing overrides the in-game pixel heuristic (which caused the old random flips).
- **Parallax**: optional `background_mid`/`background_near` keyed silhouette/prop layers,
  rendered as three wrapping tileSprites. Runner-mode backgrounds scroll now (they were
  static). Failed layers are dropped gracefully, never fatal.
- **Animated player**: Gemini generates a 2×2 run-cycle sheet, union-cropped and registered
  as a spritesheet with a 9fps run anim; transparency-gated with automatic static fallback.

## Cost / latency

- Gemini path: ~8 images + 2-4 near-free vision QA calls ≈ $0.31-0.35 per full generation,
  ~15-25s. **Requires billing enabled on the API key** — free-tier keys have
  zero image-model quota; the pipeline detects this in ~2s (quota circuit breaker) and
  routes the whole run to the free path (which skips the sheet and may drop parallax
  layers).
- Pollinations path: free; goes through the built-in Vite proxy (Turnstile blocks direct
  browser calls) and a strict serial queue (~1 concurrent generation allowed), so a full
  6-asset generation takes ~1.5–2 minutes. Auth uses the `token` query param.
- Dev flag: `localStorage.setItem('PM_FORCE_POLLINATIONS','1')` forces the free path for
  testing even when a Gemini key is baked into the bundle.

Verified end-to-end 2026-07-20: "lava runner" on the free path produced a cohesive 6-asset
set (keyed sprites, tileable magma floor, 1024×512 volcanic background) and a playable game.

## Deferred roadmap (designed, not yet implemented)

- **Parallax mid/near background layers** — slot specs + white-keyed silhouette scaffolds;
  `GameManagerScene` textureMap already carries `dyn_bg_mid`/`dyn_bg_near`.
- **Animated player** — 2×2 sprite-sheet slot with union-bbox cropping and
  `addSpriteSheet` registration; or Gemini image-editing for per-frame consistency.

See CLAUDE.md ("Deferred roadmap") for the full designs.

---

# Historical notes (pre-rebuild, resolved)

The system previously integrated SEELE AI (job/poll API via an Express CORS proxy) plus
scaffolding for Imagen/DALL-E/Stable Diffusion/Sprite Fusion that was never exercised. The
blocker was dimension control; the author's notes at the time:

> - seele seem to work but takes a lot of time
> - google is in the works and possible to generate the best output out of them, but needs
>   a lot of trial and error with teh system prompts, maybe use and sdk
>
> tldr status of the asset gen: finding the best recipe for asset generation

Resolution: went with Google via the SDK (as suspected, best output), moved the "recipe"
into a structured prompt-designer call plus code-owned scaffolds, and made post-processing
the dimension guarantee. SEELE, the proxy, and the unused provider classes were deleted.
