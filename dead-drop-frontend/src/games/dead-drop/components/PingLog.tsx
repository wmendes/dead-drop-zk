import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { gridToLatLng, formatLatLng } from '../GameMap';

type TemperatureZone = 'FOUND' | 'HOT' | 'WARM' | 'COOL' | 'COLD';

interface PingResult {
    turn: number;
    x: number;
    y: number;
    distance: number;
    zone: TemperatureZone;
}

interface PingLogProps {
    history: PingResult[];
}

function getZoneColor(zone: TemperatureZone): string {
    switch (zone) {
        case 'FOUND': return '#4ade80';
        case 'HOT': return '#ff6b6b';
        case 'WARM': return '#fbbf24';
        case 'COOL': return '#22d3ee';
        case 'COLD': return '#475569';
    }
}

export function PingLog({ history }: PingLogProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [history]);

    if (history.length === 0) return null;

    return (
        <div className="mt-2">
            <p className="text-xs font-bold uppercase tracking-wide text-terminal-green/70 mb-2 font-mono flex items-center gap-2">
                <span className="w-2 h-2 bg-terminal-green rounded-full animate-blink" />
                PING LOG
            </p>
            <div
                ref={scrollRef}
                className="max-h-32 overflow-y-auto space-y-1.5 pr-1 spy-scrollbar"
                style={{ scrollBehavior: 'smooth' }}
            >
                <AnimatePresence initial={false}>
                    {[...history].map((ping, i) => {
                        const pos = gridToLatLng(ping.x, ping.y);
                        const color = getZoneColor(ping.zone);
                        return (
                            <motion.div
                                key={`${ping.turn}-${i}`}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ duration: 0.3 }}
                                className="flex items-center justify-between py-2 px-3 rounded bg-terminal-black/70 border border-terminal-green/10 text-xs font-mono"
                            >
                                <div className="flex items-center gap-2">
                                    <span
                                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                        style={{ backgroundColor: color, boxShadow: `0 0 5px ${color}` }}
                                    />
                                    <span className="text-terminal-green/50">T{ping.turn.toString().padStart(2, '0')}</span>
                                    <span className="text-terminal-green/90">{formatLatLng(pos.lat, pos.lng)}</span>
                                </div>
                                <span className="font-bold flex items-center gap-2" style={{ color }}>
                                    {ping.zone}
                                    <span className="text-terminal-green/30 text-[10px] font-normal">d={ping.distance}</span>
                                </span>
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        </div>
    );
}
