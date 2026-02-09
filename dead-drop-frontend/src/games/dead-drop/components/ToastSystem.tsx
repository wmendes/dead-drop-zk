import { motion, AnimatePresence } from 'framer-motion';
import { useEffect } from 'react';

interface Toast {
    message: string;
    type: 'error' | 'success' | 'info';
    id: string;
}

interface ToastSystemProps {
    toast: Toast | null;
    onDismiss: () => void;
}

export function ToastSystem({ toast, onDismiss }: ToastSystemProps) {
    useEffect(() => {
        if (toast) {
            const timer = setTimeout(onDismiss, 4000);
            return () => clearTimeout(timer);
        }
    }, [toast, onDismiss]);

    return (
        <div className="fixed bottom-20 left-4 right-4 z-50 pointer-events-none flex justify-center">
            <AnimatePresence>
                {toast && (
                    <motion.div
                        initial={{ opacity: 0, y: 50, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.95 }}
                        className={`
              pointer-events-auto
              px-6 py-4 rounded-lg shadow-2xl backdrop-blur-md border
              min-w-[300px] text-center
              font-mono text-sm font-bold uppercase tracking-wide
              ${toast.type === 'error' ? 'bg-black/90 border-terminal-red text-terminal-red shadow-[0_0_20px_rgba(255,107,107,0.2)]' : ''}
              ${toast.type === 'success' ? 'bg-black/90 border-terminal-green text-terminal-green shadow-[0_0_20px_rgba(74,222,128,0.2)]' : ''}
              ${toast.type === 'info' ? 'bg-black/90 border-terminal-cyan text-terminal-cyan' : ''}
            `}
                    >
                        <div className="flex items-center justify-center gap-3">
                            <span className="text-xl">{toast.type === 'error' ? '⚠' : toast.type === 'success' ? '✓' : 'ℹ'}</span>
                            {toast.message}
                        </div>

                        {/* Progress bar */}
                        <motion.div
                            initial={{ width: '100%' }}
                            animate={{ width: '0%' }}
                            transition={{ duration: 4, ease: 'linear' }}
                            className={`absolute bottom-0 left-0 h-1 ${toast.type === 'error' ? 'bg-terminal-red' :
                                    toast.type === 'success' ? 'bg-terminal-green' : 'bg-terminal-cyan'
                                }`}
                        />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
