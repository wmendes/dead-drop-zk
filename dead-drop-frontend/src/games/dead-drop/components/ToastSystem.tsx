import { motion, AnimatePresence } from 'framer-motion';
import { useEffect } from 'react';

interface Toast {
    message: string;
    type: 'error' | 'success' | 'info';
    id: string;
    duration?: number;
}

interface ToastSystemProps {
    toast: Toast | null;
    onDismiss: () => void;
}

export function ToastSystem({ toast, onDismiss }: ToastSystemProps) {
    useEffect(() => {
        if (toast) {
            const timer = setTimeout(onDismiss, toast.duration || 2000);
            return () => clearTimeout(timer);
        }
    }, [toast, onDismiss]);

    return (
        <div className="absolute bottom-6 left-0 right-0 z-50 pointer-events-none flex justify-center px-4">
            <AnimatePresence>
                {toast && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        transition={{ type: "spring", stiffness: 300, damping: 25 }}
                        className={`
              pointer-events-auto
              px-4 py-2.5 rounded-full shadow-[0_8px_30px_rgb(0,0,0,0.5)] backdrop-blur-xl border
              min-w-[200px] max-w-sm text-center
              font-mono text-xs font-bold uppercase tracking-wider
              flex items-center gap-3 overflow-hidden relative
              ${toast.type === 'error' ? 'bg-black/90 border-terminal-red/50 text-terminal-red' : ''}
              ${toast.type === 'success' ? 'bg-black/90 border-terminal-green/50 text-terminal-green' : ''}
              ${toast.type === 'info' ? 'bg-black/90 border-terminal-cyan/50 text-terminal-cyan' : ''}
            `}
                    >
                        <span className="text-base leading-none">
                            {toast.type === 'error' ? '!' : toast.type === 'success' ? '✓' : 'i'}
                        </span>
                        <span className="flex-1 truncate">{toast.message}</span>

                        {/* subtle progress bg */}
                        <motion.div
                            initial={{ width: '100%' }}
                            animate={{ width: '0%' }}
                            transition={{ duration: 4, ease: 'linear' }}
                            className={`absolute bottom-0 left-0 h-[2px] opacity-50 ${toast.type === 'error' ? 'bg-terminal-red' :
                                toast.type === 'success' ? 'bg-terminal-green' : 'bg-terminal-cyan'
                                }`}
                        />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
