import { useId } from 'react';

interface DeadDropLogoProps {
  size?: number;
  className?: string;
  animated?: boolean;
  glow?: boolean;
}

export function DeadDropLogo({
  size = 120,
  className = '',
  animated = true,
  glow = true,
}: DeadDropLogoProps) {
  const uniqueId = useId().replace(/:/g, '');
  const glowId = `deadDropLogoGlow-${uniqueId}`;
  const sweepId = `deadDropLogoSweep-${uniqueId}`;

  return (
    <div className={className} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 120 120"
        className="h-full w-full"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={glowId} cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="rgba(52,211,153,0.45)" />
            <stop offset="70%" stopColor="rgba(2,6,23,0.45)" />
            <stop offset="100%" stopColor="rgba(2,6,23,0)" />
          </radialGradient>
          <linearGradient id={sweepId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(16,185,129,0)" />
            <stop offset="100%" stopColor="rgba(16,185,129,0.75)" />
          </linearGradient>
        </defs>

        {glow && <circle cx="60" cy="60" r="58" fill={`url(#${glowId})`} />}
        <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(52,211,153,0.22)" strokeWidth="1.5" />
        <circle cx="60" cy="60" r="38" fill="none" stroke="rgba(52,211,153,0.32)" strokeWidth="1.4" />
        <circle cx="60" cy="60" r="26" fill="none" stroke="rgba(52,211,153,0.5)" strokeWidth="1.2" />
        <circle cx="60" cy="60" r="14" fill="none" stroke="rgba(52,211,153,0.75)" strokeWidth="1.2" />
        <circle cx="60" cy="60" r="3.6" fill="rgba(52,211,153,0.95)" />

        {animated && (
          <g style={{ transformOrigin: '60px 60px', animation: 'radar-sweep 6s linear infinite' }}>
            <path d="M60 60 L60 6 A54 54 0 0 1 97 23 Z" fill={`url(#${sweepId})`} />
          </g>
        )}
      </svg>
    </div>
  );
}
