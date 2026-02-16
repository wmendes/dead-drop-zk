import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
    contentClassName?: string;
}

export function Modal({ isOpen, onClose, title, children, contentClassName }: ModalProps) {
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="absolute inset-0 bg-black/70 backdrop-blur-sm z-[9998]"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />

                    {/* Modal */}
                    <motion.div
                        className="absolute inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 pointer-events-none"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                    >
                        <motion.div
                            className="pointer-events-auto w-full max-w-md max-h-[calc(100%-1.5rem)] sm:max-h-[calc(100%-2rem)] bg-slate-900/95 border border-emerald-500/20 rounded-xl shadow-2xl overflow-hidden flex flex-col min-h-0"
                            initial={{ opacity: 0, scale: 0.96, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96, y: 10 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                        >
                            {/* Header */}
                            {title && (
                                <div className="flex items-center justify-between px-3.5 py-2.5 sm:px-4 sm:py-3 border-b border-emerald-500/10">
                                    <h3 className="text-[11px] sm:text-sm font-bold text-emerald-400 uppercase tracking-widest">{title}</h3>
                                    <button
                                        onClick={onClose}
                                        className="p-1 text-slate-400 hover:text-white transition-colors"
                                        aria-label="Close modal"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                            )}

                            {/* Content */}
                            <div className={`p-3 sm:p-4 flex-1 min-h-0 overflow-x-hidden overflow-y-auto spy-scrollbar ${contentClassName ?? ''}`}>
                                {children}
                            </div>
                        </motion.div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
