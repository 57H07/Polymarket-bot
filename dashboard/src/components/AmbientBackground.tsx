import { useEffect, useRef } from 'react';

interface AmbientBackgroundProps {
  /** Accent used for the particle mesh. Defaults to the design canvas purple. */
  accent?: string;
  /** Set false to render only the static auras (no canvas animation). */
  particles?: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const LINK_DIST_SQ = 16000;

/**
 * Ambient page backdrop from the design canvas: two drifting radial auras,
 * a radially-masked grid, and a slow particle mesh painted on a canvas.
 * Purely decorative — sits behind `.app-shell` and never takes pointer events.
 */
export function AmbientBackground({ accent = '#9b8cff', particles = true }: AmbientBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!particles) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let width = 0;
    let height = 0;
    let parts: Particle[] = [];
    let raf = 0;

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(70, Math.round((width * height) / 26000));
      parts = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: 0.7 + Math.random() * 1.5,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        for (let j = i + 1; j < parts.length; j++) {
          const q = parts[j];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST_SQ) {
            ctx.strokeStyle = accent;
            ctx.globalAlpha = 0.09 * (1 - d2 / LINK_DIST_SQ);
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }

        ctx.globalAlpha = 0.34;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    draw();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [accent, particles]);

  return (
    <>
      <div className="ambient-layer" aria-hidden="true">
        <div
          className="ambient-aura animate-sheen"
          style={{
            top: '-18%',
            left: '-8%',
            width: '60vw',
            height: '60vw',
            background: 'radial-gradient(circle, rgba(112,86,255,0.20), rgba(112,86,255,0) 62%)',
          }}
        />
        <div
          className="ambient-aura animate-sheen"
          style={{
            bottom: '-26%',
            right: '-12%',
            width: '55vw',
            height: '55vw',
            background: 'radial-gradient(circle, rgba(0,200,160,0.14), rgba(0,200,160,0) 65%)',
            animationDirection: 'reverse',
            animationDuration: '16s',
          }}
        />
        <div className="ambient-grid" />
      </div>
      {particles && <canvas ref={canvasRef} className="ambient-particles" aria-hidden="true" />}
    </>
  );
}
