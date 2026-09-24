"use client";

import { useRef, useState } from "react";

type BeforeAfterComparisonProps = {
  beforeImage: string;
  afterImage: string;
  beforeLabel?: string;
  afterLabel?: string;
};

export function BeforeAfterComparison({
  beforeImage,
  afterImage,
  beforeLabel = "装修前",
  afterLabel = "装修后",
}: BeforeAfterComparisonProps) {
  const [position, setPosition] = useState(50);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  function updatePosition(clientX: number) {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  }

  return (
    <div
      className="before-after-comparison"
      ref={containerRef}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        updatePosition(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging.current) updatePosition(event.clientX);
      }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      role="group"
      aria-label="装修前后滑动对比"
    >
      <img className="before-after-image before-after-image-after" src={afterImage} alt={afterLabel} />
      <img
        className="before-after-image before-after-image-before"
        src={beforeImage}
        alt={beforeLabel}
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      />
      <div className="before-after-divider" style={{ left: `${position}%` }} aria-hidden="true">
        <span>↔</span>
      </div>
      <span className="before-after-label before-after-label-before">{beforeLabel}</span>
      <span className="before-after-label before-after-label-after">{afterLabel}</span>
    </div>
  );
}
