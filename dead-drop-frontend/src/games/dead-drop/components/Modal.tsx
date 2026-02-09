import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9998]"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />

                    {/* Modal */}
                    <motion.div
                        className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[9999] max-w-md mx-auto"
                        initial={{ opacity: 0, scale: 0.95, y: '-45%' }}
                        animate={{ opacity: 1, scale: 1, y: '-50%' }}
                        exit={{ opacity: 0, scale: 0.95, y: '-45%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    >
                        <div className="bg-slate-900/95 border border-emerald-500/20 rounded-xl shadow-2xl overflow-hidden">
                            {/* Header */}
                            {title && (
                                <div className="flex items-center justify-between px-4 py-3 border-b border-emerald-500/10">
                                    <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-widest">{title}</h3>
                                    <button
                                        onClick={onClose}
                                        className="p-1 text-slate-400 hover:text-white transition-colors"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                            )}

                            {/* Content */}
                            <div className="p-4 max-h-[60vh] overflow-y-auto">
                                {children}
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
