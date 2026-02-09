import { motion } from 'framer-motion';

interface GameHUDProps {
    sessionId: number;
    currentTurn: number;
    maxTurns: number;
    gamePhase: string;
    onDevTrigger: () => void;
}

export function GameHUD({ sessionId, currentTurn, maxTurns, gamePhase, onDevTrigger }: GameHUDProps) {
    return (
        <div className="flex items-center justify-between py-2 px-3 bg-terminal-black/80 rounded border border-terminal-green/20 backdrop-blur-md sticky top-0 z-20 shadow-lg shadow-black/20">
            <div
                className="flex items-center gap-3 cursor-pointer select-none"
                onClick={(e) => {
                    if (e.detail === 3) onDevTrigger(); // Triple click trigger
                }}
            >
                <div className="flex flex-col">
                    <span className="text-[10px] text-terminal-green/50 uppercase tracking-widest leading-none mb-0.5">Session</span>
                    <span className="font-mono text-sm font-bold text-terminal-green shadow-glow-green">#{sessionId}</span>
                </div>

                <div className="h-6 w-px bg-terminal-green/20"></div>

                <div className="flex flex-col">
                    <span className="text-[10px] text-terminal-amber/50 uppercase tracking-widest leading-none mb-0.5">Turn</span>
                    <span className="font-mono text-sm font-bold text-terminal-amber shadow-glow-amber">
                        {currentTurn}<span className="text-terminal-amber/40 text-xs">/{maxTurns}</span>
                    </span>
                </div>
            </div>

            {gamePhase !== 'create' && (
                <motion.span
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    key={gamePhase}
                    className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider font-mono border ${gamePhase === 'my_turn' ? 'bg-terminal-green/20 text-terminal-green border-terminal-green/50 animate-pulse' :
                            gamePhase === 'opponent_turn' ? 'bg-terminal-amber/20 text-terminal-amber border-terminal-amber/50' :
                                gamePhase === 'commit' ? 'bg-purple-500/20 text-purple-400 border-purple-500/50' :
                                    gamePhase === 'waiting_commit' ? 'bg-terminal-cyan/20 text-terminal-cyan border-terminal-cyan/50' :
                                        'bg-slate-700/60 text-slate-400 border-slate-600/50'
                        }`}
                >
                    {gamePhase.replace(/_/g, ' ')}
                </motion.span>
            )}
        </div>
    );
}
