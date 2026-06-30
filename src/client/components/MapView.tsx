import React, { useEffect, useState, useRef, useMemo } from 'react';
import { api } from '../App';

export interface MapViewProps {
  slotId?: string; // Optional slot to load specific farm.
}

interface Tile {
  name: string;
  x: number;
  y: number;
  [key: string]: any; // Allows other fields dynamically based on object type
}

interface FarmData {
  mapType: string;
  mapTypeIndex: number;
  size: { width: number; height: number };
  house: { x: number; y: number; width: number; height: number; upgradeLevel: number };
  greenhouse: { x: number; y: number; unlocked: boolean };
  buildings: Tile[];
  objects: Tile[];
  fences: Tile[];
  flooring: Tile[];
  hoeDirt: Tile[];
  crops: Tile[];
  terrainFeatures: Tile[];
  largeTerrainFeatures: Tile[];
  resourceClumps: Tile[];
}

interface FarmResponse {
  slot: string;
  source_mtime: number;
  parsed_at: number;
  data: FarmData;
}

interface SavesResponse {
  slots: { slot: string }[];
}

const TILE_SIZE = 16; // pixels per Stardew tile

export function MapView({ slotId }: MapViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [activeSlot, setActiveSlot] = useState<string | null>(slotId || null);
  const [farmData, setFarmData] = useState<FarmData | null>(null);

  // Asset loading logic
  const [assets, setAssets] = useState<{ [key: string]: HTMLImageElement }>({});
  const [assetsLoaded, setAssetsLoaded] = useState(false);

  useEffect(() => {
    const imagesToLoad = [
      'springobjects.png', 'Craftables.png', 'crops.png', 'flooring.png', 'hoeDirt.png',
      'houses.png', 'bushes.png', 'grass.png', 'fruitTrees.png',
      'tree1_spring.png', 'tree2_spring.png', 'tree3_spring.png',
      'Barn.png', 'Big Barn.png', 'Deluxe Barn.png',
      'Coop.png', 'Big Coop.png', 'Deluxe Coop.png',
      'Log Cabin.png', 'Plank Cabin.png', 'Stone Cabin.png',
      'Silo.png', 'Slime Hutch.png', 'Stable.png', 'Well.png', 'Mill.png', 'Shed.png',
      'Fish Pond.png', 'Junimo Hut.png', 'Gold Clock.png', 'Shipping Bin.png',
      'Earth Obelisk.png', 'Water Obelisk.png', 'Desert Obelisk.png',
      'Fence1.png', 'Fence2.png', 'Fence3.png', 'Fence5.png'
    ];
    const loadedImages: { [key: string]: HTMLImageElement } = {};
    let loadedCount = 0;

    imagesToLoad.forEach(src => {
      const img = new Image();
      img.onload = () => {
        loadedImages[src] = img;
        loadedCount++;
        if (loadedCount === imagesToLoad.length) {
          setAssets(loadedImages);
          setAssetsLoaded(true);
        }
      };
      img.onerror = () => {
        console.warn(`Failed to load asset: ${src}`);
        loadedCount++;
        if (loadedCount === imagesToLoad.length) {
          setAssets(loadedImages);
          setAssetsLoaded(true);
        }
      };
      img.src = `/assets/${src}`;
    });
  }, []);

  // For panning and zooming
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // 1. Fetch available slots if no active slot is provided
  useEffect(() => {
    async function loadSlots() {
      try {
        const mapUrl = localStorage.getItem('junimo_map_api_url') || 'http://localhost:8080';

        // Use direct fetch against the mapUrl since this component can be used in DirectApp.tsx
        // where we don't have the Node.js proxy `/api/map/*` available.
        const res = await fetch(`${mapUrl}/saves`, {
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error('Failed to fetch saves');
        const data: SavesResponse = await res.json();

        const availableSlots = data.slots.map(s => s.slot);
        setSlots(availableSlots);
        if (!activeSlot && availableSlots.length > 0) {
          setActiveSlot(availableSlots[0]);
        }
      } catch (e: any) {
        setError(e.message || 'Error loading saves');
      }
    }
    loadSlots();
  }, [activeSlot]);

  // 2. Fetch farm data when active slot changes
  useEffect(() => {
    if (!activeSlot) return;

    let active = true;
    async function loadFarm() {
      setLoading(true);
      setError(null);
      try {
        const mapUrl = localStorage.getItem('junimo_map_api_url') || 'http://localhost:8080';

        const res = await fetch(`${mapUrl}/saves/${activeSlot}/farm`, {
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) {
           throw new Error(`Failed to load farm data for ${activeSlot} (${res.status})`);
        }
        const data: FarmResponse = await res.json();

        if (active) {
          setFarmData(data.data);
          // Center the map initially
          if (containerRef.current) {
            const cw = containerRef.current.clientWidth;
            const ch = containerRef.current.clientHeight;
            const mw = data.data.size.width * TILE_SIZE;
            const mh = data.data.size.height * TILE_SIZE;
            
            // Fit to screen scale
            const fitScale = Math.min(cw / mw, ch / mh) * 0.9;
            setScale(Math.max(0.5, Math.min(fitScale, 2)));
            
            // Center offset
            setOffset({
              x: (cw - mw * fitScale) / 2,
              y: (ch - mh * fitScale) / 2
            });
          }
        }
      } catch (e: any) {
        if (active) setError(e.message || 'Error loading farm data');
      } finally {
        if (active) setLoading(false);
      }
    }

    loadFarm();
    return () => { active = false; };
  }, [activeSlot]);

  // 3. Render map on canvas when farmData changes
  useEffect(() => {
    if (!farmData || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas logical size to match the farm grid
    const width = farmData.size.width * TILE_SIZE;
    const height = farmData.size.height * TILE_SIZE;
    canvas.width = width;
    canvas.height = height;

    // Draw background (basic grass/dirt representation based on map type)
    ctx.fillStyle = getMapBackgroundColor(farmData.mapType);
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += TILE_SIZE) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y <= height; y += TILE_SIZE) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    // Helper to draw a colored rectangle for a tile (fallback)
    const drawTile = (x: number, y: number, w: number, h: number, color: string, label?: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.strokeRect(x * TILE_SIZE, y * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE);

      if (label) {
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, (x + w/2) * TILE_SIZE, (y + h/2) * TILE_SIZE);
      }
    };

    // Helper to draw a sprite from a sprite sheet
    const drawSprite = (
      sheet: string,
      spriteIndex: number,
      x: number,
      y: number,
      w: number = 1,
      h: number = 1,
      spriteWidth: number = 16,
      spriteHeight: number = 16
    ) => {
      const img = assets[sheet];
      if (!img) return;

      const cols = Math.floor(img.width / spriteWidth);
      const sx = (spriteIndex % cols) * spriteWidth;
      const sy = Math.floor(spriteIndex / cols) * spriteHeight;

      ctx.drawImage(
        img,
        sx, sy, spriteWidth, spriteHeight, // Source
        x * TILE_SIZE, y * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE // Destination
      );
    };

    // Render layers (bottom to top)

    // Flooring (using flooring.png)
    farmData.flooring?.forEach(f => {
      // In Stardew, flooring index usually maps to specific auto-tiled textures.
      // We'll just draw the base tile for the index for now.
      const index = f.index || 0;
      drawSprite('flooring.png', index, f.x, f.y, 1, 1, 64, 64); // Flooring tiles are often 64x64 or auto-tiled
    });

    // HoeDirt (using hoeDirt.png)
    farmData.hoeDirt?.forEach(h => {
      // Simplification: draw base hoe dirt
      drawSprite('hoeDirt.png', 0, h.x, h.y, 1, 1, 16, 16);
    });

    // Crops (using crops.png)
    farmData.crops?.forEach(c => {
      const row = c.rowInSpriteSheet || 0;
      const phase = c.currentPhase || 0;
      const index = row * 8 + phase; // Crops sheet is typically 8 wide per crop type
      drawSprite('crops.png', index, c.x, c.y, 1, 2, 16, 32);
    });

    // Fences
    farmData.fences?.forEach(f => {
      // Fences are complex to auto-tile. We'll just draw the base pillar.
      let fenceFile = 'Fence1.png'; // Wood
      if (f.isGate) fenceFile = 'Fence1.png'; // Simplify
      else if (f.whichType === 2) fenceFile = 'Fence2.png'; // Stone
      else if (f.whichType === 3) fenceFile = 'Fence3.png'; // Iron
      else if (f.whichType === 5) fenceFile = 'Fence5.png'; // Hardwood

      drawSprite(fenceFile, 5, f.x, f.y, 1, 2, 16, 32); // Using index 5 as a generic post
    });

    // Terrain Features (Trees, Grass)
    farmData.terrainFeatures?.forEach(t => {
      if (t.name === 'Tree') {
        const treeType = t.treeType || 1;
        let treeFile = 'tree1_spring.png'; // Oak
        if (treeType === 2) treeFile = 'tree2_spring.png'; // Maple
        if (treeType === 3) treeFile = 'tree3_spring.png'; // Pine

        const growthStage = t.growthStage || 5;
        if (growthStage >= 5) {
          // Full grown tree
          drawSprite(treeFile, 0, t.x - 1, t.y - 3, 3, 4, 48, 64);
        } else {
          // Sapling/Seed (simplified)
          drawSprite(treeFile, 26, t.x, t.y, 1, 1, 16, 16);
        }
      } else if (t.name === 'FruitTree') {
        drawSprite('fruitTrees.png', 0, t.x - 1, t.y - 3, 3, 4, 48, 64); // Highly simplified
      } else if (t.name === 'Grass') {
        drawSprite('grass.png', 0, t.x, t.y, 1, 1, 16, 16);
      } else {
        drawTile(t.x, t.y, 1, 1, '#556b2f'); // Fallback
      }
    });

    // Large Terrain Features (Bushes)
    farmData.largeTerrainFeatures?.forEach(t => {
      const size = t.size || 1; // 0=small, 1=medium, 2=large
      const w = size === 2 ? 3 : (size === 1 ? 2 : 1);
      const h = size === 2 ? 3 : (size === 1 ? 2 : 1);
      drawSprite('bushes.png', size, t.x, t.y - (h-1), w, h, w * 16, h * 16);
    });

    // Resource Clumps (Boulders, Large Stumps)
    farmData.resourceClumps?.forEach(r => {
      // Hardcoded mapping for stumps/boulders based on width/height or parentSheetIndex
      if (r.width === 2 && r.height === 2) {
         drawSprite('springobjects.png', 732, r.x, r.y, 2, 2, 32, 32); // Large stump approx
      } else {
         drawTile(r.x, r.y, r.width || 2, r.height || 2, '#696969'); // Fallback
      }
    });

    // Objects (using springobjects.png and Craftables.png)
    farmData.objects?.forEach(o => {
      if (o.bigCraftable) {
        drawSprite('Craftables.png', o.parentSheetIndex, o.x, o.y - 1, 1, 2, 16, 32); // Craftables are 16x32
      } else {
        drawSprite('springobjects.png', o.parentSheetIndex, o.x, o.y, 1, 1, 16, 16); // Springobjects are 16x16
      }
    });

    // Buildings (using houses.png for Farmhouse, specific files for others)
    farmData.buildings?.forEach(b => {
      if (b.buildingType === 'Farmhouse' || b.name === 'Farmhouse') {
         drawSprite('houses.png', 0, b.x, b.y, b.width, b.height, 144, 144); // Approx size
      } else {
         const buildingFile = `${b.buildingType || b.name}.png`;
         if (assets[buildingFile]) {
            // Most building sprites have their actual dimensions in the png
            const img = assets[buildingFile];
            drawSprite(buildingFile, 0, b.x, b.y + b.height - (img.height / 16), img.width / 16, img.height / 16, img.width, img.height);
         } else {
            drawTile(b.x, b.y, b.width, b.height, '#b22222', b.buildingType || b.name);
         }
      }
    });

    // Greenhouse
    if (farmData.greenhouse) {
      const { x, y, unlocked } = farmData.greenhouse;
      drawTile(x, y, 7, 6, unlocked ? '#20b2aa' : '#778899', 'Greenhouse');
    }

    // House
    if (farmData.house) {
      const { x, y, width, height } = farmData.house;
      // Draw using houses.png. The index depends on upgrade level (0, 1, 2)
      // Usually houses are stacked horizontally or vertically in houses.png
      drawSprite('houses.png', 0, x, y, width, height, 144, 144); // Simplified
    }

  }, [farmData, assetsLoaded, assets]);

  // Panning/Zooming handlers
  const handleWheel = (e: React.WheelEvent) => {
    if (!containerRef.current) return;
    
    // Determine zoom point relative to container
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.2, Math.min(scale * zoomFactor, 5));

    if (newScale !== scale) {
      // Adjust offset so we zoom into the mouse position
      const dx = (mouseX - offset.x) * (newScale / scale - 1);
      const dy = (mouseY - offset.y) * (newScale / scale - 1);
      
      setScale(newScale);
      setOffset({
        x: offset.x - dx,
        y: offset.y - dy
      });
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  function getMapBackgroundColor(mapType: string): string {
    switch (mapType) {
      case 'Beach': return '#f4a460'; // Sandy brown
      case 'Riverland': return '#87ceeb'; // Light sky blue
      case 'Wilderness': return '#2e8b57'; // Dark olive green
      default: return '#9acd32'; // Yellow green (standard grass)
    }
  }

  return (
    <div className="map-view-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="map-view-header" style={{ display: 'flex', gap: '16px', padding: '16px', backgroundColor: 'var(--bg-card)', borderBottom: '2px solid var(--border-color)', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Farm Map</h2>
        
        <select 
          value={activeSlot || ''} 
          onChange={(e) => setActiveSlot(e.target.value)}
          disabled={slots.length === 0}
          className="stardew-select"
        >
          <option value="" disabled>Select a save slot</option>
          {slots.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        
        <div style={{ flex: 1 }} />
        
        <div className="zoom-controls" style={{ display: 'flex', gap: '8px' }}>
          <button className="secondary-button" onClick={() => setScale(s => Math.max(0.2, s * 0.8))}>Zoom Out</button>
          <span style={{ display: 'flex', alignItems: 'center', fontFamily: 'monospace' }}>{Math.round(scale * 100)}%</span>
          <button className="secondary-button" onClick={() => setScale(s => Math.min(5, s * 1.2))}>Zoom In</button>
        </div>
      </div>

      <div 
        className="map-canvas-container" 
        ref={containerRef}
        style={{ 
          flex: 1, 
          overflow: 'hidden', 
          position: 'relative',
          backgroundColor: '#1a1a1a', // Dark background for the canvas container
          cursor: isDragging ? 'grabbing' : 'grab'
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        {loading && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white', backgroundColor: 'rgba(0,0,0,0.7)', padding: '16px', borderRadius: '8px', zIndex: 10 }}>
            Loading map data...
          </div>
        )}
        
        {error && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'var(--danger)', backgroundColor: 'rgba(0,0,0,0.8)', padding: '16px', borderRadius: '8px', zIndex: 10 }}>
            {error}
          </div>
        )}

        {!loading && !error && !farmData && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: '#888' }}>
            No map data available. Select a save slot.
          </div>
        )}

        <canvas 
          ref={canvasRef}
          style={{
            position: 'absolute',
            transformOrigin: '0 0',
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            imageRendering: 'pixelated', // Keep it sharp!
            boxShadow: '0 0 20px rgba(0,0,0,0.5)'
          }}
        />
        
        {/* Legend Overlay */}
        {farmData && (
          <div style={{ 
            position: 'absolute', 
            bottom: '16px', 
            left: '16px', 
            backgroundColor: 'var(--bg-card)', 
            padding: '12px', 
            border: '2px solid var(--border-color)',
            borderRadius: '4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontSize: '14px'
          }}>
            <div style={{fontWeight: 'bold', borderBottom: '1px solid var(--border-color)', paddingBottom: '4px', marginBottom: '4px'}}>Legend</div>
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}><div style={{width: 12, height: 12, backgroundColor: '#cd5c5c'}}></div> Farmhouse</div>
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}><div style={{width: 12, height: 12, backgroundColor: '#20b2aa'}}></div> Greenhouse</div>
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}><div style={{width: 12, height: 12, backgroundColor: '#b22222'}}></div> Buildings</div>
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}><div style={{width: 12, height: 12, backgroundColor: '#2ecc71'}}></div> Crops</div>
            <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}><div style={{width: 12, height: 12, backgroundColor: '#654321'}}></div> Tilled Dirt</div>
          </div>
        )}
      </div>
    </div>
  );
}
