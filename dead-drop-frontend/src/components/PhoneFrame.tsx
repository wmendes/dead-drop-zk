import type { ReactNode } from 'react';

interface PhoneFrameProps {
  children: ReactNode;
}

export function PhoneFrame({ children }: PhoneFrameProps) {
  return (
    <>
      {/* Desktop: phone mockup */}
      <div className="phone-frame-wrapper">
        <div className="phone-bezel">
          <div className="phone-notch" />
          <div className="phone-screen">
            {children}
          </div>
          <div className="phone-home-indicator" />
        </div>
      </div>

      {/* Mobile: render directly */}
      <div className="phone-mobile-view">
        {children}
      </div>
    </>
  );
}
