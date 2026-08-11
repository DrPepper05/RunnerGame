// Share-link v2 (2026-08-11): slim payload + game id.
//
// v1 links serialized the ENTIRE liveParams — assetMeta bulk plus garbage `{}`
// entries for the non-serializable HTMLImageElements — into 11-14KB URLs that
// carried no art anyway. v2 strips both and keeps only what a boot needs, plus
// the gameId that lets the local asset cache (and, later, a server backend)
// restore the real AI art. The `#config=` param name is unchanged and decode
// falls back to the v1 format, so old links keep working.

// Only the load-bearing boot fields of assetMeta survive on the link: frames
// (spritesheet registration + animation), facingVerified (sprite alignment),
// dropped (optional-slot state). Everything else feeds only the cost report.
const stripForShare = (liveParams) => {
  const { preloadedImages: _pi, assetMeta, ...config } = liveParams || {};
  const slots = assetMeta?.slots;
  if (slots) {
    const lite = {};
    for (const [slot, m] of Object.entries(slots)) {
      const entry = {};
      if (m?.frames) entry.frames = m.frames;
      if (m?.facingVerified != null) entry.facingVerified = m.facingVerified;
      if (m?.dropped) entry.dropped = true;
      if (Object.keys(entry).length) lite[slot] = entry;
    }
    if (Object.keys(lite).length) config.assetMetaLite = { slots: lite };
  }
  return config;
};

export const encodeShareConfig = (liveParams) => {
  const json = JSON.stringify(stripForShare(liveParams));
  // Unicode-safe base64 — plain btoa threw (silently) on non-Latin-1 prompts.
  return btoa(unescape(encodeURIComponent(json)));
};

export const decodeShareConfig = (encoded) => {
  const raw = atob(encoded);
  let json;
  try {
    json = decodeURIComponent(escape(raw));
  } catch {
    json = raw; // pre-v2 links were plain Latin-1 btoa output
  }
  return JSON.parse(json);
};
