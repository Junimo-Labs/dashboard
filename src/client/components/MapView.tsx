import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * MapView renders a Stardew Valley farm to a canvas by porting the sprite logic
 * of SDV-Summary (https://github.com/Sketchy502/SDV-Summary) `generateFarm`.
 *
 * The upstream Junimo-Api `/saves/{slot}/farm` endpoint is itself adapted from
 * SDV-Summary's `getFarmInfo`, so the JSON we receive maps almost 1:1 onto the
 * original renderer. Server-side we already get the per-tile `orientation` for
 * auto-tiled features (fences / flooring / hoe dirt), so the client only has to
 * crop sprites and composite them in the correct draw order.
 */

export interface MapViewProps {
  slotId?: string;
}

type Season = 'spring' | 'summer' | 'fall' | 'winter';
const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter'];

const TILE = 16; // pixels per in-game tile
const MAP_API_KEY = 'junimo_map_api_url';
const DEFAULT_MAP_API = 'http://localhost:8080';

// ---------------------------------------------------------------------------
// Data contract (mirrors Junimo-Api/app/parser/farm.py)
// ---------------------------------------------------------------------------

interface BaseTile {
  name: string;
  x: number;
  y: number;
  flipped?: boolean;
}

interface FenceTile extends BaseTile {
  index: number;
  type: number; // 1 wood, 2 stone, 3 iron, 5 hardwood
  isGate?: boolean;
  orientation: number;
}

interface FloorTile extends BaseTile {
  type: number;
  orientation: number;
}

interface CropTile extends BaseTile {
  rowInSpriteSheet: number;
  currentPhase: number;
  dead?: boolean;
  tint?: { rgb: number[]; daysOfCurrentPhase: number } | null;
}

interface TerrainTile extends BaseTile {
  treeType?: number;
  growthStage?: number;
  grassType?: number;
  numberOfWeeds?: number;
  size?: number;
}

interface LargeTerrainTile extends BaseTile {
  size: number;
  tileSheetOffset: number;
}

interface ClumpTile extends BaseTile {
  width: number;
  height: number;
  parentSheetIndex: number;
}

interface ObjectTile extends BaseTile {
  displayName: string;
  index: number;
  type: string;
  extra: string | { name: string; tint: number[] };
}

interface BuildingTile extends BaseTile {
  buildingType: string;
  width: number;
  height: number;
  upgradeLevel?: number;
  fishPond?: { nettingStyle: number; waterColor: number[]; hasOutput: boolean };
}

interface FarmData {
  mapType: string;
  mapTypeIndex: number;
  size: { width: number; height: number };
  house: { x: number; y: number; width: number; height: number; upgradeLevel: number };
  greenhouse: { x: number; y: number; unlocked: boolean };
  buildings: BuildingTile[];
  objects: ObjectTile[];
  fences: FenceTile[];
  flooring: FloorTile[];
  hoeDirt: FloorTile[];
  crops: CropTile[];
  terrainFeatures: TerrainTile[];
  largeTerrainFeatures: LargeTerrainTile[];
  resourceClumps: ClumpTile[];
}

interface FarmResponse {
  slot: string;
  data: FarmData;
}

interface SummaryResponse {
  data?: { summary?: { currentSeason?: string } | null } | null;
}

interface SavesResponse {
  slots: { slot: string }[];
}

// ---------------------------------------------------------------------------
// Sprite-sheet helpers (port of SDV-Summary tools.cropImg)
// ---------------------------------------------------------------------------

interface SpriteRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * cropImg semantics: the sprite `index` is decomposed on a grid of `defaultW`
 * cells, but the crop itself spans `objW`x`objH`. This is what lets a 16x32
 * sprite be indexed on a 16x16 grid.
 */
function spriteRect(
  sheetWidth: number,
  index: number,
  defaultW: number,
  defaultH: number,
  objW: number,
  objH: number,
): SpriteRect {
  const cols = Math.max(1, Math.floor(sheetWidth / defaultW));
  return {
    sx: (index % cols) * defaultW,
    sy: Math.floor(index / cols) * defaultH,
    sw: objW,
    sh: objH,
  };
}

function blit(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  r: SpriteRect,
  dx: number,
  dy: number,
  flip = false,
) {
  if (!flip) {
    ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, dx, dy, r.sw, r.sh);
    return;
  }
  ctx.save();
  ctx.translate(dx + r.sw, dy);
  ctx.scale(-1, 1);
  ctx.drawImage(src, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
  ctx.restore();
}

/** Mirrors PIL colorize(grayscale(img), black, tint): luminance scaled to tint. */
function tintSprite(src: CanvasImageSource, rect: SpriteRect, tint: number[]): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = rect.sw;
  off.height = rect.sh;
  const octx = off.getContext('2d')!;
  octx.drawImage(src, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  const data = octx.getImageData(0, 0, rect.sw, rect.sh);
  const [tr, tg, tb] = tint;
  for (let i = 0; i < data.data.length; i += 4) {
    const gray =
      (data.data[i] * 299 + data.data[i + 1] * 587 + data.data[i + 2] * 114) / 1000;
    const f = gray / 255;
    data.data[i] = Math.round(tr * f);
    data.data[i + 1] = Math.round(tg * f);
    data.data[i + 2] = Math.round(tb * f);
  }
  octx.putImageData(data, 0, 0);
  return off;
}

// Deterministic PRNG so grass tufts render identically every pass.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: () => number, a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

const CRAFTABLE_BLACKLIST = new Set([
  'Twig',
  'Stone',
  'Weeds',
  'Torch',
  'Sprinkler',
  'Quality Sprinkler',
  'Iridium Sprinkler',
  'Note Block',
  'Jack-O-Lantern',
]);

const TREE_FILES: Record<number, (s: Season) => string> = {
  1: (s) => `tree1_${s}.png`,
  2: (s) => `tree2_${s}.png`,
  3: (s) => (s === 'summer' ? 'tree3_spring.png' : `tree3_${s}.png`),
  7: () => 'mushroom_tree.png',
};

function mapBackground(mapType: string, season: Season): string {
  if (season === 'winter') return '#dfe6ec';
  if (season === 'fall') return '#b9863f';
  if (mapType === 'Beach') return '#d9c08a';
  if (mapType === 'Riverland') return '#6aa9c9';
  if (season === 'summer') return '#7cab3f';
  return '#6f9e43';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MapView({ slotId }: MapViewProps) {
  const [slots, setSlots] = useState<string[]>([]);
  const [activeSlot, setActiveSlot] = useState<string | null>(slotId ?? null);
  const [farmData, setFarmData] = useState<FarmData | null>(null);
  const [season, setSeason] = useState<Season>('spring');
  const [autoSeason, setAutoSeason] = useState(true);
  const [showGrid, setShowGrid] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // View transform
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const [isDragging, setIsDragging] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // On-demand asset cache; loading a new sheet bumps assetVersion to re-render.
  const assetCache = useRef<Map<string, HTMLImageElement | null>>(new Map());
  const [assetVersion, setAssetVersion] = useState(0);

  const getImg = useCallback((file: string): HTMLImageElement | null => {
    const cache = assetCache.current;
    if (cache.has(file)) return cache.get(file) ?? null;
    cache.set(file, null);
    const img = new Image();
    img.onload = () => {
      cache.set(file, img);
      setAssetVersion((v) => v + 1);
    };
    img.onerror = () => {
      cache.set(file, null);
    };
    img.src = `/assets/${encodeURIComponent(file)}`;
    return null;
  }, []);

  const mapApiUrl = () => localStorage.getItem(MAP_API_KEY) || DEFAULT_MAP_API;

  const fitToScreen = useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const mw = canvas.width;
    const mh = canvas.height;
    if (!mw || !mh) return;
    const fit = Math.min(cw / mw, ch / mh) * 0.94;
    const next = Math.max(0.2, Math.min(fit, 4));
    setScale(next);
    setOffset({ x: (cw - mw * next) / 2, y: (ch - mh * next) / 2 });
  }, []);

  // 1. Load slot list
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${mapApiUrl()}/saves`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Failed to list saves (${res.status})`);
        const data: SavesResponse = await res.json();
        if (!alive) return;
        const available = data.slots.map((s) => s.slot);
        setSlots(available);
        setActiveSlot((cur) => cur ?? available[0] ?? null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Error loading saves');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 2. Load farm + season for the active slot
  useEffect(() => {
    if (!activeSlot) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const base = mapApiUrl();
        const [farmRes, summaryRes] = await Promise.all([
          fetch(`${base}/saves/${activeSlot}/farm`, { headers: { Accept: 'application/json' } }),
          fetch(`${base}/saves/${activeSlot}`, { headers: { Accept: 'application/json' } }).catch(
            () => null,
          ),
        ]);
        if (!farmRes.ok) throw new Error(`Failed to load farm for ${activeSlot} (${farmRes.status})`);
        const farm: FarmResponse = await farmRes.json();
        if (!alive) return;
        setFarmData(farm.data);

        if (summaryRes && summaryRes.ok) {
          try {
            const summary: SummaryResponse = await summaryRes.json();
            const s = summary.data?.summary?.currentSeason?.toLowerCase();
            if (alive && autoSeason && s && (SEASONS as string[]).includes(s)) {
              setSeason(s as Season);
            }
          } catch {
            /* season is optional */
          }
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Error loading farm data');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // autoSeason intentionally excluded: toggling it shouldn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot]);

  // Fit once a new farm is rendered to a sized canvas.
  useEffect(() => {
    if (farmData) {
      // defer so the canvas has its dimensions set by the render effect
      requestAnimationFrame(fitToScreen);
    }
  }, [farmData, fitToScreen]);

  // 3. Render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !farmData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = farmData.size.width * TILE;
    const height = farmData.size.height * TILE;
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;

    // Background
    ctx.fillStyle = mapBackground(farmData.mapType, season);
    ctx.fillRect(0, 0, width, height);

    if (showGrid) {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += TILE) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += TILE) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
        ctx.stroke();
      }
    }

    const rng = makeRng(0);
    const gates: FenceTile[] = [];

    // --- Floors first (flooring + hoe dirt), across the whole map ---
    const flooring = getImg('Flooring.png');
    if (flooring) {
      for (const f of farmData.flooring ?? []) {
        const block = spriteRect(flooring.width, f.type, 64, 64, 64, 64);
        const vCols = 4; // 64px block -> four 16px views
        const vx = (f.orientation % vCols) * TILE;
        const vy = Math.floor(f.orientation / vCols) * TILE;
        blit(
          ctx,
          flooring,
          { sx: block.sx + vx, sy: block.sy + vy, sw: TILE, sh: TILE },
          f.x * TILE,
          f.y * TILE,
        );
      }
    }
    const hoeSheet = getImg(season === 'winter' ? 'hoeDirtSnow.png' : 'hoeDirt.png');
    if (hoeSheet) {
      for (const h of farmData.hoeDirt ?? []) {
        blit(ctx, hoeSheet, spriteRect(hoeSheet.width, h.orientation, TILE, TILE, TILE, TILE), h.x * TILE, h.y * TILE);
      }
    }

    // --- Everything else, sorted bottom-to-top by tile y ---
    type Drawable =
      | { kind: 'crop'; t: CropTile }
      | { kind: 'object'; t: ObjectTile }
      | { kind: 'fence'; t: FenceTile }
      | { kind: 'terrain'; t: TerrainTile }
      | { kind: 'large'; t: LargeTerrainTile }
      | { kind: 'clump'; t: ClumpTile }
      | { kind: 'building'; t: BuildingTile }
      | { kind: 'house'; t: { x: number; y: number } }
      | { kind: 'greenhouse'; t: { x: number; y: number } };

    const items: Drawable[] = [
      ...(farmData.crops ?? []).map((t) => ({ kind: 'crop', t }) as Drawable),
      ...(farmData.objects ?? []).map((t) => ({ kind: 'object', t }) as Drawable),
      ...(farmData.fences ?? []).map((t) => ({ kind: 'fence', t }) as Drawable),
      ...(farmData.terrainFeatures ?? []).map((t) => ({ kind: 'terrain', t }) as Drawable),
      ...(farmData.largeTerrainFeatures ?? []).map((t) => ({ kind: 'large', t }) as Drawable),
      ...(farmData.resourceClumps ?? []).map((t) => ({ kind: 'clump', t }) as Drawable),
      ...(farmData.buildings ?? []).map((t) => ({ kind: 'building', t }) as Drawable),
    ];
    if (farmData.house) items.push({ kind: 'house', t: farmData.house });
    if (farmData.greenhouse) items.push({ kind: 'greenhouse', t: farmData.greenhouse });
    // Stable sort by tile y so southern sprites overlap northern ones.
    items.sort((a, b) => a.t.y - b.t.y);

    // houses.png (1.6): three farmhouse upgrade levels stacked vertically,
    // 160x144 each. The greenhouse lives in its own Greenhouse.png sheet.
    const houses = getImg('houses.png');

    for (const item of items) {
      switch (item.kind) {
        case 'crop':
          drawCrop(ctx, item.t, getImg('crops.png'));
          break;
        case 'object':
          drawObject(ctx, item.t, getImg('springobjects.png'), getImg('Craftables.png'));
          break;
        case 'fence':
          drawFence(ctx, item.t, getImg, gates);
          break;
        case 'terrain':
          drawTerrain(ctx, item.t, season, getImg, rng);
          break;
        case 'large':
          drawBush(ctx, item.t, season, getImg('bushes.png'));
          break;
        case 'clump':
          drawClump(ctx, item.t, getImg('springobjects.png'));
          break;
        case 'building':
          drawBuilding(ctx, item.t, season, getImg);
          break;
        case 'greenhouse':
          // 1.6 layout: Greenhouse.png is its own sheet, stacked vertically —
          // top 112x160 = broken/locked, bottom 112x160 = intact/unlocked.
          {
            const ghSheet = getImg('Greenhouse.png');
            if (ghSheet) {
              const gh = farmData.greenhouse;
              blit(
                ctx,
                ghSheet,
                { sx: 0, sy: gh.unlocked ? 160 : 0, sw: 112, sh: 160 },
                gh.x * TILE,
                (gh.y - 6) * TILE,
              );
            }
          }
          break;
        case 'house':
          if (houses) {
            const h = farmData.house;
            const lvl = h.upgradeLevel === 3 ? 2 : Math.min(h.upgradeLevel ?? 0, 2);
            blit(
              ctx,
              houses,
              { sx: 0, sy: lvl * 144, sw: 160, sh: 144 },
              h.x * TILE,
              (h.y - 6) * TILE,
            );
          }
          break;
      }
    }

    // Deferred gates draw on top of their posts.
    for (const g of gates) {
      const file = fenceFile(g.type);
      const sheet = file ? getImg(file) : null;
      if (!sheet) continue;
      const rect = spriteRect(sheet.width, g.orientation, TILE, TILE * 2, 24, TILE * 2);
      blit(ctx, sheet, rect, g.x * TILE - 4, g.y * TILE - TILE, g.flipped);
    }
  }, [farmData, season, showGrid, assetVersion, getImg]);

  // --- Interaction ---
  const onWheel = (e: React.WheelEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const next = Math.max(0.2, Math.min(scale * factor, 6));
    if (next === scale) return;
    setOffset({
      x: mx - (mx - offset.x) * (next / scale),
      y: my - (my - offset.y) * (next / scale),
    });
    setScale(next);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y, active: true };
    setIsDragging(true);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current.active) return;
    setOffset({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
  };
  const endDrag = () => {
    dragRef.current.active = false;
    setIsDragging(false);
  };

  const counts = useMemo(() => {
    if (!farmData) return null;
    return {
      buildings: farmData.buildings?.length ?? 0,
      crops: farmData.crops?.length ?? 0,
      trees: (farmData.terrainFeatures ?? []).filter((t) => t.name === 'Tree' || t.name === 'FruitTree')
        .length,
      objects: farmData.objects?.length ?? 0,
    };
  }, [farmData]);

  const zoomPct = Math.round(scale * 100);

  return (
    <div className="mapview">
      <header className="mapview-toolbar">
        <div className="mapview-title">
          <span className="mapview-title-icon" aria-hidden>🗺️</span>
          <div>
            <h2>Farm Map</h2>
            <p>Live render from the save parser</p>
          </div>
        </div>

        <div className="mapview-controls">
          <label className="mapview-field">
            <span>Save slot</span>
            <select
              className="stardew-select"
              value={activeSlot ?? ''}
              onChange={(e) => setActiveSlot(e.target.value)}
              disabled={slots.length === 0}
            >
              {slots.length === 0 && <option value="">No saves found</option>}
              {slots.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="mapview-field">
            <span>Season</span>
            <select
              className="stardew-select"
              value={season}
              onChange={(e) => {
                setAutoSeason(false);
                setSeason(e.target.value as Season);
              }}
            >
              {SEASONS.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={`mapview-toggle ${showGrid ? 'is-active' : ''}`}
            onClick={() => setShowGrid((g) => !g)}
            aria-pressed={showGrid}
          >
            {showGrid ? 'Grid on' : 'Grid off'}
          </button>
        </div>
      </header>

      <div
        className="mapview-stage"
        ref={containerRef}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        style={{ cursor: isDragging ? 'grabbing' : farmData ? 'grab' : 'default' }}
      >
        {loading && (
          <div className="mapview-overlay">
            <div className="mapview-spinner" aria-hidden />
            <p>Loading farm…</p>
          </div>
        )}

        {!loading && error && (
          <div className="mapview-overlay mapview-overlay-error">
            <span className="mapview-overlay-icon" aria-hidden>⚠️</span>
            <p>{error}</p>
            <button type="button" onClick={() => activeSlot && setActiveSlot(activeSlot)}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && !farmData && (
          <div className="mapview-overlay">
            <span className="mapview-overlay-icon" aria-hidden>🌱</span>
            <p>No farm loaded yet. Pick a save slot to render the map.</p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="mapview-canvas"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            visibility: farmData ? 'visible' : 'hidden',
          }}
        />

        {farmData && (
          <div className="mapview-zoom">
            <button type="button" onClick={() => setScale((s) => Math.max(0.2, s * 0.8))} aria-label="Zoom out">
              −
            </button>
            <span>{zoomPct}%</span>
            <button type="button" onClick={() => setScale((s) => Math.min(6, s * 1.25))} aria-label="Zoom in">
              +
            </button>
            <button type="button" className="mapview-zoom-fit" onClick={fitToScreen}>
              Fit
            </button>
          </div>
        )}

        {farmData && counts && (
          <div className="mapview-info">
            <div className="mapview-info-row">
              <span className="mapview-info-label">Map</span>
              <span className="mapview-info-value">{farmData.mapType}</span>
            </div>
            <div className="mapview-info-stats">
              <div>
                <strong>{counts.buildings}</strong>
                <span>Buildings</span>
              </div>
              <div>
                <strong>{counts.crops}</strong>
                <span>Crops</span>
              </div>
              <div>
                <strong>{counts.trees}</strong>
                <span>Trees</span>
              </div>
              <div>
                <strong>{counts.objects}</strong>
                <span>Objects</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-feature renderers (ports of generateFarm branches)
// ---------------------------------------------------------------------------

function fenceFile(type: number): string | null {
  if (type === 1) return 'Fence1.png';
  if (type === 2) return 'Fence2.png';
  if (type === 3) return 'Fence3.png';
  if (type === 5) return 'Fence5.png';
  return 'Fence1.png';
}

function drawCrop(ctx: CanvasRenderingContext2D, t: CropTile, sheet: HTMLImageElement | null) {
  if (!sheet) return;
  // crops.png: each crop type is a 128x32 strip; phases are 16-wide columns.
  const strip = spriteRect(sheet.width, t.rowInSpriteSheet, 128, 32, 128, 32);
  const isFlower = [26, 27, 28, 29, 31].includes(t.rowInSpriteSheet);

  let img: CanvasImageSource = sheet;
  let rect: SpriteRect;

  if (!isFlower || !t.tint) {
    const local = spriteRect(128, t.currentPhase, TILE, 32, TILE, 32);
    rect = { sx: strip.sx + local.sx, sy: strip.sy + local.sy, sw: TILE, sh: 32 };
  } else {
    // Blooming flowers composite a tinted head over the body.
    const days = t.tint.daysOfCurrentPhase;
    const T = t.rowInSpriteSheet;
    const bloomed =
      (T === 26 && days > 1) ||
      (T === 27 && days > 2) ||
      (T === 28 && days > 2) ||
      (T === 29 && days > 2) ||
      (T === 31 && days > 3);

    if (t.currentPhase < 4) {
      const local = spriteRect(128, t.currentPhase, TILE, 32, TILE, 32);
      rect = { sx: strip.sx + local.sx, sy: strip.sy + local.sy, sw: TILE, sh: 32 };
    } else {
      const off = document.createElement('canvas');
      off.width = TILE;
      off.height = 32;
      const octx = off.getContext('2d')!;
      const bodyLocal = spriteRect(128, bloomed ? 5 : 4, TILE, 32, TILE, 32);
      octx.drawImage(
        sheet,
        strip.sx + bodyLocal.sx,
        strip.sy + bodyLocal.sy,
        TILE,
        32,
        0,
        0,
        TILE,
        32,
      );
      if (bloomed) {
        const headLocal = spriteRect(128, 6, TILE, 32, TILE, 32);
        const head = tintSprite(
          sheet,
          { sx: strip.sx + headLocal.sx, sy: strip.sy + headLocal.sy, sw: TILE, sh: 32 },
          t.tint.rgb,
        );
        octx.drawImage(head, 0, 0);
      }
      img = off;
      rect = { sx: 0, sy: 0, sw: TILE, sh: 32 };
    }
  }
  blit(ctx, img, rect, t.x * TILE, t.y * TILE - TILE, t.flipped);
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  t: ObjectTile,
  objects: HTMLImageElement | null,
  craftables: HTMLImageElement | null,
) {
  const isChest =
    typeof t.extra === 'object' && t.extra !== null && Array.isArray(t.extra.tint) && t.extra.tint.length === 3;

  if (isChest && craftables) {
    const extra = t.extra as { name: string; tint: number[] };
    let tint = extra.tint;
    if (extra.name === 'Chest' && tint[0] === 0 && tint[1] === 0 && tint[2] === 0) {
      tint = [211, 139, 71];
    }
    const bodyRect = spriteRect(craftables.width, 168, TILE, 32, TILE, 32);
    const body = tintSprite(craftables, bodyRect, tint);
    const overlayRect = spriteRect(craftables.width, 176, TILE, 32, TILE, 32);
    const octx = body.getContext('2d')!;
    octx.drawImage(craftables, overlayRect.sx, overlayRect.sy, TILE, 32, 0, 0, TILE, 32);
    blit(ctx, body, { sx: 0, sy: 0, sw: TILE, sh: 32 }, t.x * TILE, t.y * TILE - 16, t.flipped);
    return;
  }

  const craftable = t.type === 'Crafting' && !CRAFTABLE_BLACKLIST.has(t.displayName);
  if (craftable && craftables) {
    const rect = spriteRect(craftables.width, t.index, TILE, 32, TILE, 32);
    blit(ctx, craftables, rect, t.x * TILE, t.y * TILE - 16, t.flipped);
  } else if (objects) {
    const rect = spriteRect(objects.width, t.index, TILE, TILE, TILE, TILE);
    blit(ctx, objects, rect, t.x * TILE, t.y * TILE, t.flipped);
  }
}

function drawFence(
  ctx: CanvasRenderingContext2D,
  t: FenceTile,
  getImg: (file: string) => HTMLImageElement | null,
  gates: FenceTile[],
) {
  if (t.orientation === 12 && t.isGate) {
    gates.push(t); // closed gate, drawn after the loop
    return;
  }
  const file = fenceFile(t.type);
  const sheet = file ? getImg(file) : null;
  if (!sheet) return;

  let offsetX = 0;
  let rect: SpriteRect;
  if (t.orientation === 15 && t.isGate) {
    rect = spriteRect(sheet.width, t.orientation, TILE, TILE * 2, 8, TILE);
    offsetX = 5;
  } else {
    rect = spriteRect(sheet.width, t.orientation, TILE, TILE * 2, TILE, TILE * 2);
  }
  blit(ctx, sheet, rect, t.x * TILE + offsetX, t.y * TILE - TILE, t.flipped);
}

function drawClump(ctx: CanvasRenderingContext2D, t: ClumpTile, objects: HTMLImageElement | null) {
  if (!objects) return;
  const rect = spriteRect(objects.width, t.parentSheetIndex, TILE, TILE, 32, 32);
  blit(ctx, objects, rect, t.x * TILE, t.y * TILE);
}

function drawBush(
  ctx: CanvasRenderingContext2D,
  t: LargeTerrainTile,
  season: Season,
  bushes: HTMLImageElement | null,
) {
  if (!bushes) return;
  // Port of generateFarm's "Bush" branch. `size` (0/1/2) selects the sprite
  // footprint; `tileSheetOffset` is the animation/variant offset.
  const size = Math.max(0, Math.min(t.size, 2));
  const variant = t.tileSheetOffset ?? 0;
  const sizes: [number, number][] = [
    [TILE, 32],
    [32, 48],
    [48, 48],
  ];
  const [w, h] = sizes[size];

  let seasonOffset = 0;
  if (size === 0) {
    seasonOffset = { spring: 0, summer: 2, fall: 4, winter: 6 }[season];
  } else if (size === 1) {
    if (season === 'summer') seasonOffset = 4 + variant * 2;
    else if (season === 'fall') seasonOffset = 8 * 3;
    else if (season === 'winter') seasonOffset = 8 * 3 + 4;
  } else if (size === 2) {
    if (season === 'fall') seasonOffset = 3;
    else if (season === 'winter') seasonOffset = 8 * 3;
  }

  const base = [8 * 14, 8 * 0, 8 * 8][size];
  const index = base + seasonOffset;
  const rect = spriteRect(bushes.width, index, TILE, h, w, h);
  blit(ctx, bushes, rect, t.x * TILE, t.y * TILE - h + TILE, t.flipped);
}

function drawTerrain(
  ctx: CanvasRenderingContext2D,
  t: TerrainTile,
  season: Season,
  getImg: (file: string) => HTMLImageElement | null,
  rng: () => number,
) {
  if (t.name === 'Tree') {
    drawTree(ctx, t, season, getImg);
  } else if (t.name === 'FruitTree') {
    drawFruitTree(ctx, t, season, getImg('fruitTrees.png'));
  } else if (t.name === 'Grass') {
    drawGrass(ctx, t, season, getImg('grass.png'), rng);
  } else if (t.name === 'Tea_Bush') {
    drawTeaBushTerrain(ctx, t, season, getImg('bushes.png'));
  }
}

function drawTeaBushTerrain(
  ctx: CanvasRenderingContext2D,
  t: TerrainTile,
  season: Season,
  bushes: HTMLImageElement | null,
) {
  if (!bushes) return;
  const growth = t.growthStage ?? 0;
  const seasonOffsetX = season === 'summer' || season === 'winter' ? 64 : 0;
  const seasonOffsetY = season === 'fall' || season === 'winter' ? 32 : 0;
  const sheetX = seasonOffsetX + growth * 16;
  const index = Math.floor(sheetX / 16 + ((256 + seasonOffsetY) / 32) * 8);
  const rect = spriteRect(bushes.width, index, TILE, 32, TILE, 32);
  blit(ctx, bushes, rect, t.x * TILE, t.y * TILE, t.flipped);
}

function drawTree(
  ctx: CanvasRenderingContext2D,
  t: TerrainTile,
  season: Season,
  getImg: (file: string) => HTMLImageElement | null,
) {
  const type = t.treeType ?? 1;
  const fileFn = TREE_FILES[type];
  if (!fileFn) return;
  const sheet = getImg(fileFn(season));
  if (!sheet) return;
  const growth = t.growthStage ?? 5;

  if (growth >= 5) {
    // Full tree: composite trunk + canopy (port of loadTree).
    const off = document.createElement('canvas');
    off.width = 48;
    off.height = 96;
    const octx = off.getContext('2d')!;
    const stump = spriteRect(sheet.width, 20, TILE, TILE, TILE, 32);
    octx.drawImage(sheet, stump.sx, stump.sy, TILE, 32, TILE, 64, TILE, 32);
    octx.drawImage(sheet, 0, 0, 48, 96, 0, 0, 48, 96);
    const img = t.flipped ? flipCanvas(off) : off;
    ctx.drawImage(img, t.x * TILE - TILE, t.y * TILE - 80);
    return;
  }

  let rect: SpriteRect;
  let offsetY = 0;
  if (growth === 0) rect = spriteRect(sheet.width, 26, TILE, TILE, TILE, TILE);
  else if (growth === 1) rect = spriteRect(sheet.width, 24, TILE, TILE, TILE, TILE);
  else if (growth === 2) rect = spriteRect(sheet.width, 25, TILE, TILE, TILE, TILE);
  else {
    rect = spriteRect(sheet.width, 18, TILE, TILE, TILE, 32);
    offsetY = 16;
  }
  blit(ctx, sheet, rect, t.x * TILE, t.y * TILE - offsetY, t.flipped);
}

function drawFruitTree(
  ctx: CanvasRenderingContext2D,
  t: TerrainTile,
  season: Season,
  sheet: HTMLImageElement | null,
) {
  if (!sheet) return;
  const type = t.treeType ?? 0;
  const growth = t.growthStage ?? 4;
  const seasonIdx = { spring: 0, summer: 1, fall: 2, winter: 3 }[season];
  const index = growth <= 3 ? growth + 1 + 9 * type : 4 + seasonIdx + 9 * type;
  const rect = spriteRect(sheet.width, index, 48, 80, 48, 80);
  blit(ctx, sheet, rect, t.x * TILE - TILE, t.y * TILE - 64, t.flipped);
}

function drawGrass(
  ctx: CanvasRenderingContext2D,
  t: TerrainTile,
  season: Season,
  sheet: HTMLImageElement | null,
  rng: () => number,
) {
  if (!sheet || season === 'winter') return; // no winter grass sprite
  const base = { spring: 0, summer: 4, fall: 8 }[season];
  const tufts = t.numberOfWeeds ?? 0;
  for (let i = 0; i < tufts; i++) {
    const idx = base + randInt(rng, 0, 2);
    const rect = spriteRect(sheet.width, idx, TILE, 20, TILE, 20);
    const offY = 8 + (2 & i) * 4 - 16 + randInt(rng, -2, 2);
    const offX = 12 + (1 & i) * 8 - 16 + randInt(rng, -2, 2);
    blit(ctx, sheet, rect, t.x * TILE + offX, t.y * TILE + offY);
  }
}

function drawBuilding(
  ctx: CanvasRenderingContext2D,
  t: BuildingTile,
  season: Season,
  getImg: (file: string) => HTMLImageElement | null,
) {
  const type = t.buildingType;
  const lower = type.toLowerCase();
  if (lower === 'farmhouse' || lower === 'house') return; // handled by house field

  if (lower === 'fish pond' && t.fishPond) {
    const sheet = getImg('Fish Pond.png');
    if (!sheet) return;
    const pond = renderFishPond(sheet, t.fishPond);
    ctx.drawImage(pond, t.x * TILE, t.y * TILE - 32);
    return;
  }

  if (lower === 'junimo hut') {
    const sheet = getImg('Junimo Hut.png');
    if (!sheet) return;
    // Seasonal: each season is a 48-wide column.
    const col = SEASONS.indexOf(season);
    const offsetY = 64 - t.height * TILE;
    ctx.drawImage(sheet, col * 48, 0, 48, 64, t.x * TILE, t.y * TILE - offsetY, 48, 64);
    return;
  }

  const sheet = getImg(`${type}.png`);
  if (!sheet) return;
  const offsetY = sheet.height - t.height * TILE;

  if (lower.includes('cabin')) {
    // Cabin sheets hold upgrade columns of width (tilesWide * 16).
    const colW = t.width * TILE;
    const upgrade = t.upgradeLevel ?? 0;
    ctx.drawImage(
      sheet,
      upgrade * colW,
      0,
      colW,
      sheet.height,
      t.x * TILE,
      t.y * TILE - offsetY,
      colW,
      sheet.height,
    );
    return;
  }

  // Some buildings (e.g. Mill) pack animation frames to the right of the base
  // sprite. When the sheet is wider than the tile footprint, only draw the
  // leftmost footprint-width columns so the extra frames aren't tiled in.
  const footprintW = t.width * TILE;
  if (footprintW > 0 && sheet.width > footprintW) {
    ctx.drawImage(
      sheet,
      0,
      0,
      footprintW,
      sheet.height,
      t.x * TILE,
      t.y * TILE - offsetY,
      footprintW,
      sheet.height,
    );
    return;
  }

  ctx.drawImage(sheet, t.x * TILE, t.y * TILE - offsetY);
}

/** Port of buildings/fish_pond.render_fish_pond. */
function renderFishPond(
  sheet: HTMLImageElement,
  pond: { nettingStyle: number; waterColor: number[]; hasOutput: boolean },
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = 5 * TILE;
  out.height = 7 * TILE;
  const octx = out.getContext('2d')!;

  // Tinted water body.
  const water = tintSprite(sheet, { sx: 0, sy: 5 * TILE, sw: 5 * TILE, sh: 5 * TILE }, pond.waterColor);
  octx.drawImage(water, 0, 2 * TILE);

  // Water detail + base frame (untinted).
  octx.drawImage(sheet, TILE, 10 * TILE, 3 * TILE, TILE, TILE, 3 * TILE, 3 * TILE, TILE);
  octx.drawImage(sheet, 0, 0, 5 * TILE, 5 * TILE, 0, 2 * TILE, 5 * TILE, 5 * TILE);

  if (pond.hasOutput) {
    octx.drawImage(sheet, 0, 10 * TILE, TILE, TILE, 4 * TILE + 1, 5 * TILE + 11, TILE, TILE);
  }

  if ([0, 1, 2].includes(pond.nettingStyle)) {
    const h = 3 * TILE;
    const y = pond.nettingStyle * h;
    octx.drawImage(sheet, 5 * TILE, y, 5 * TILE, h, 0, 0, 5 * TILE, h);
  }
  return out;
}

function flipCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const octx = out.getContext('2d')!;
  octx.translate(src.width, 0);
  octx.scale(-1, 1);
  octx.drawImage(src, 0, 0);
  return out;
}
