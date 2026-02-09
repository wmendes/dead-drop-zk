import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

interface ActionButtonProps {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: 'primary' | 'danger' | 'warning' | 'default';
    icon?: React.ReactNode;
    fullWidth?: boolean;
}

export function ActionButton({
    label,
    onClick,
    disabled,
    loading,
    variant = 'default',
    icon,
    fullWidth = false
}: ActionButtonProps) {

    const getColors = () => {
        switch (variant) {
            case 'primary': return 'bg-terminal-green text-terminal-black border-terminal-green hover:bg-emerald-400 font-bold shadow-[0_0_15px_rgba(74,222,128,0.4)]';
            case 'danger': return 'bg-terminal-black text-terminal-red border-terminal-red/50 hover:bg-terminal-red/10';
            case 'warning': return 'bg-terminal-amber text-terminal-black border-terminal-amber hover:bg-amber-400';
            default: return 'bg-terminal-green/10 text-terminal-green border-terminal-green/40 hover:bg-terminal-green/20';
        }
    };

    return (
        <motion.button
            whileTap={{ scale: 0.98 }}
            whileHover={!disabled ? { scale: 1.02, boxShadow: '0 0 20px rgba(74,222,128,0.2)' } : {}}
            onClick={onClick}
            disabled={disabled || loading}
            className={`
        relative overflow-hidden
        py-3 px-6 rounded-lg font-mono text-sm uppercase tracking-widest transition-all
        disabled:opacity-50 disabled:cursor-not-allowed
        border
        ${getColors()}
        ${fullWidth ? 'w-full' : ''}
      `}
        >
            <div className="flex items-center justify-center gap-2 relative z-10">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {!loading && icon}
                <span>{loading ? 'PROCESSING...' : label}</span>
            </div>

            {/* Scanline overlay for button */}
            {!disabled && variant === 'primary' && (
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/10 to-transparent opacity-0 hover:opacity-100 animate-scanline pointer-events-none" />
            )}
        </motion.button>
    );
}
