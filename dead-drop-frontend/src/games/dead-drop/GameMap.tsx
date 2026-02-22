import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, useMapEvents, useMap } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';
import { zoneColorHex, type TemperatureZone } from './temperatureZones';

const GRID_SIZE = 100;
const MAP_CENTER: [number, number] = [20, 0];
const MAP_DEFAULT_ZOOM = 2;
const MAP_MIN_ZOOM = 2;
const MAP_MAX_ZOOM = 4;
const MAP_BOUNDS: [[number, number], [number, number]] = [[-85, -180], [85, 180]];

interface PingResult {
  turn: number;
  x: number;
  y: number;
  distance: number;
  zone: TemperatureZone;
  player: string;
}

// --- Coordinate conversion ---

export function latLngToGrid(lat: number, lng: number): { x: number; y: number } {
  const x = Math.floor(((lng + 180) % 360) / 360 * GRID_SIZE) % GRID_SIZE;
  const y = Math.floor(((lat + 90) % 180) / 180 * GRID_SIZE) % GRID_SIZE;
  return { x: Math.abs(x), y: Math.abs(y) };
}

export function gridToLatLng(x: number, y: number): { lat: number; lng: number } {
  const lng = (x / GRID_SIZE) * 360 - 180 + 1.8;
  const lat = (y / GRID_SIZE) * 180 - 90 + 0.9;
  return { lat, lng };
}

export function formatLatLng(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}${ns}, ${Math.abs(lng).toFixed(1)}${ew}`;
}

// --- Sub-components ---

function MapClickHandler({ onCellSelect }: { onCellSelect: (cell: { x: number; y: number }) => void }) {
  useMapEvents({
    click(e: LeafletMouseEvent) {
      const cell = latLngToGrid(e.latlng.lat, e.latlng.lng);
      onCellSelect(cell);
    },
  });
  return null;
}

function CoordOverlay() {
  const map = useMap();
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    const handler = (e: LeafletMouseEvent) => setCoords({ lat: e.latlng.lat, lng: e.latlng.lng });
    const leaveHandler = () => setCoords(null);
    map.on('mousemove', handler);
    map.getContainer().addEventListener('mouseleave', leaveHandler);
    return () => {
      map.off('mousemove', handler);
      map.getContainer().removeEventListener('mouseleave', leaveHandler);
    };
  }, [map]);

  if (!coords) return null;
  const grid = latLngToGrid(coords.lat, coords.lng);
  return (
    <div className="absolute bottom-2 left-2 z-[1000] px-3 py-1 bg-black/80 border border-green-500/30 backdrop-blur-sm rounded pointer-events-none shadow-[0_0_10px_rgba(74,222,128,0.2)]">
      <span className="font-mono text-xs font-bold text-green-400 drop-shadow-[0_0_5px_rgba(74,222,128,0.5)]">
        {formatLatLng(coords.lat, coords.lng)} <span className="text-green-400/50">({grid.x},{grid.y})</span>
      </span>
    </div>
  );
}

// --- Main component ---

interface GameMapProps {
  pingHistory: PingResult[];
  selectedCell: { x: number; y: number } | null;
  onCellSelect: (cell: { x: number; y: number }) => void;
  interactive: boolean;
  showDrop?: boolean;
  dropCoords?: { x: number; y: number } | null;
  userAddress?: string;
}

export function GameMap({ pingHistory, selectedCell, onCellSelect, interactive, showDrop, dropCoords, userAddress }: GameMapProps) {
  const handleCellSelect = useCallback((cell: { x: number; y: number }) => {
    if (interactive) onCellSelect(cell);
  }, [interactive, onCellSelect]);

  const pingMarkers = useMemo(() => pingHistory
    .map((ping, i) => {
    const pos = gridToLatLng(ping.x, ping.y);
    const color = zoneColorHex(ping.zone);
    const isMe = userAddress ? ping.player === userAddress : true;
    return (
      <CircleMarker
        key={`ping-${i}`}
        center={[pos.lat, pos.lng]}
        radius={6}
        pathOptions={{
          color: isMe ? 'rgba(255,255,255,0.9)' : 'rgba(251,191,36,0.9)',
          weight: isMe ? 1 : 1.5,
          fillColor: color,
          fillOpacity: isMe ? 0.85 : 0.5,
          dashArray: isMe ? undefined : '3, 3',
        }}
      />
    );
  }), [pingHistory, userAddress]);

  const selectedMarker = useMemo(() => {
    if (!selectedCell) return null;
    const pos = gridToLatLng(selectedCell.x, selectedCell.y);
    return (
      <CircleMarker
        center={[pos.lat, pos.lng]}
        radius={8}
        pathOptions={{
          color: '#4ade80',
          weight: 2,
          fillColor: 'transparent',
          fillOpacity: 0,
          dashArray: '5, 5'
        }}
      />
    );
  }, [selectedCell]);

  /* Debug Markers */
  const debugMarkers = useMemo(() => {
    if (!showDrop) return null;

    const markers = [];

    // Drop Location
    if (dropCoords) {
      const pos = gridToLatLng(dropCoords.x, dropCoords.y);
      markers.push(
        <React.Fragment key="drop-marker">
          <CircleMarker
            center={[pos.lat, pos.lng]}
            radius={15}
            pathOptions={{
              color: '#fbbf24',
              weight: 2,
              fillColor: 'rgba(251, 191, 36, 0.2)',
              fillOpacity: 0.5,
              dashArray: '5, 5',
            }}
          />
          <CircleMarker
            center={[pos.lat, pos.lng]}
            radius={4}
            pathOptions={{
              color: '#fbbf24',
              weight: 2,
              fillColor: '#fbbf24',
              fillOpacity: 1,
            }}
          />
        </React.Fragment>
      );
    }

    return markers;
  }, [showDrop, dropCoords]);

  return (
    <div className="relative spy-scanlines w-full h-full">
      <div
        className={`
          rounded-xl overflow-hidden border transition-all duration-500 relative h-full w-full
          ${interactive
            ? 'border-green-500/50 shadow-[0_0_30px_rgba(74,222,128,0.2)]'
            : 'border-green-500/20 grayscale-[50%]'
          }
        `}
      >
        <MapContainer
          center={MAP_CENTER}
          zoom={MAP_DEFAULT_ZOOM}
          minZoom={MAP_MIN_ZOOM}
          maxZoom={MAP_MAX_ZOOM}
          maxBounds={MAP_BOUNDS}
          maxBoundsViscosity={1}
          zoomControl={false}
          worldCopyJump={true}
          attributionControl={false}
          style={{ width: '100%', height: '100%', background: '#020617' }}
        >
          {/* Map tiles */}
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
            opacity={1}
          />

          {interactive && <MapClickHandler onCellSelect={handleCellSelect} />}
          {interactive && <CoordOverlay />}

          {pingMarkers}
          {selectedMarker}
          {debugMarkers}
        </MapContainer>

        {/* Radar Scanner Overlay */}
        {!interactive && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
            <div className="spy-radar-container w-32 h-32">
              <div className="spy-radar-sweep" />
              <div className="absolute inset-0 border border-green-500/20 rounded-full" />
              <div className="absolute inset-8 border border-green-500/20 rounded-full" />
              <span className="text-[10px] font-bold font-mono text-green-500 animate-pulse absolute bottom-2">SCANNING...</span>
            </div>
          </div>
        )}
      </div>

      {/* Decorative corners */}
      <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-green-500/40 rounded-tl-lg -translate-x-1 -translate-y-1 pointer-events-none" />
      <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-green-500/40 rounded-tr-lg translate-x-1 -translate-y-1 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-green-500/40 rounded-bl-lg -translate-x-1 translate-y-1 pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-green-500/40 rounded-br-lg translate-x-1 translate-y-1 pointer-events-none" />
    </div>
  );
}
