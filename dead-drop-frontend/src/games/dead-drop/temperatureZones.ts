export type TemperatureZone =
  | 'FOUND'
  | 'BURNING'
  | 'VERY_HOT'
  | 'HOT'
  | 'WARM'
  | 'COOL'
  | 'CHILLY'
  | 'COLD'
  | 'FREEZING';

export type ZonePingPattern = 'single' | 'double' | 'triple' | 'found';

export function distanceToZone(distance: number): TemperatureZone {
  const normalized = Math.max(0, Math.floor(distance));

  if (normalized === 0) return 'FOUND';
  if (normalized <= 2) return 'BURNING';
  if (normalized <= 5) return 'VERY_HOT';
  if (normalized <= 9) return 'HOT';
  if (normalized <= 14) return 'WARM';
  if (normalized <= 24) return 'COOL';
  if (normalized <= 39) return 'CHILLY';
  if (normalized <= 59) return 'COLD';
  return 'FREEZING';
}

export function zoneLabel(zone: TemperatureZone): string {
  switch (zone) {
    case 'FOUND':
      return 'FOUND';
    case 'BURNING':
      return 'BURNING';
    case 'VERY_HOT':
      return 'VERY HOT';
    case 'HOT':
      return 'HOT';
    case 'WARM':
      return 'WARM';
    case 'COOL':
      return 'COOL';
    case 'CHILLY':
      return 'CHILLY';
    case 'COLD':
      return 'COLD';
    case 'FREEZING':
      return 'FREEZING';
  }
}

export function zoneColorHex(zone: TemperatureZone): string {
  switch (zone) {
    case 'FOUND':
      return '#4ade80';
    case 'BURNING':
      return '#f43f5e';
    case 'VERY_HOT':
      return '#ff6b6b';
    case 'HOT':
      return '#f97316';
    case 'WARM':
      return '#fbbf24';
    case 'COOL':
      return '#22d3ee';
    case 'CHILLY':
      return '#38bdf8';
    case 'COLD':
      return '#3b82f6';
    case 'FREEZING':
      return '#475569';
  }
}

export function zoneTextClass(zone: TemperatureZone): string {
  switch (zone) {
    case 'FOUND':
      return 'text-emerald-400';
    case 'BURNING':
      return 'text-rose-400';
    case 'VERY_HOT':
      return 'text-red-400';
    case 'HOT':
      return 'text-orange-400';
    case 'WARM':
      return 'text-amber-400';
    case 'COOL':
      return 'text-cyan-400';
    case 'CHILLY':
      return 'text-sky-400';
    case 'COLD':
      return 'text-blue-400';
    case 'FREEZING':
      return 'text-slate-400';
  }
}

export function zoneFrequency(zone: TemperatureZone): number {
  switch (zone) {
    case 'FREEZING':
      return 150;
    case 'COLD':
      return 210;
    case 'CHILLY':
      return 280;
    case 'COOL':
      return 360;
    case 'WARM':
      return 480;
    case 'HOT':
      return 620;
    case 'VERY_HOT':
      return 760;
    case 'BURNING':
      return 920;
    case 'FOUND':
      return 1200;
  }
}

export function zonePingPattern(zone: TemperatureZone): ZonePingPattern {
  if (zone === 'FOUND') return 'found';
  if (zone === 'BURNING') return 'triple';
  if (zone === 'VERY_HOT') return 'double';
  return 'single';
}
