import { motion } from 'framer-motion';
import { Buffer } from 'buffer';

interface SpyCardProps {
    label: string;
    address?: string;
    isMe: boolean;
    commitment?: any; // strict typing would be better, but sticking to existing pattern for now
    bestDist?: number;
    isWinner?: boolean;
    isActive?: boolean;
}

export function SpyCard({ label, address, isMe, commitment, bestDist, isWinner, isActive }: SpyCardProps) {
    const committed = commitment && Buffer.from(commitment as any).some((b: number) => b !== 0);

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`spy-dossier-card rounded-lg p-3 backdrop-blur-sm transition-all relative ${isActive
                    ? 'border-terminal-amber/50 shadow-[0_0_15px_rgba(251,191,36,0.3)]'
                    : isMe
                        ? 'border-terminal-green/40'
                        : 'border-terminal-green/20'
                }`}
        >
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wide text-terminal-green/80 font-mono">
                    {label}
                </span>
                {isMe && <span className="spy-classified-stamp text-[10px] py-0.5 px-1.5 transform -rotate-2">YOU</span>}
                {isWinner && (
                    <motion.span
                        initial={{ scale: 2, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="text-xs font-bold text-terminal-green uppercase tracking-wide font-mono drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]"
                    >
                        WINNER
                    </motion.span>
                )}
            </div>

            <div className="font-mono text-xs text-terminal-green/70 mb-3 truncate">
                {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'UNKNOWN AGENT'}
            </div>

            <div className="flex gap-2 items-center flex-wrap">
                <span
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold font-mono uppercase tracking-wide border ${committed
                            ? 'bg-terminal-green/20 text-terminal-green border-terminal-green/40 shadow-[0_0_5px_rgba(74,222,128,0.3)]'
                            : 'bg-slate-800/60 text-slate-500 border-slate-700/40'
                        }`}
                >
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${committed ? 'bg-terminal-green animate-pulse' : 'bg-slate-600'
                            }`}
                    />
                    {committed ? 'LOCKED' : 'PENDING'}
                </span>

                {bestDist !== undefined && bestDist !== 4294967295 && (
                    <span className="px-2 py-1 rounded bg-terminal-cyan/20 text-terminal-cyan text-[10px] font-bold font-mono border border-terminal-cyan/40 shadow-[0_0_5px_rgba(34,211,238,0.3)]">
                        BEST: {bestDist}
                    </span>
                )}
            </div>

            {/* Corner accents */}
            <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-terminal-green/50 rounded-tl-sm pointer-events-none" />
            <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-terminal-green/50 rounded-tr-sm pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-terminal-green/50 rounded-bl-sm pointer-events-none" />
            <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-terminal-green/50 rounded-br-sm pointer-events-none" />
        </motion.div>
    );
}
