"use client";

import { useEffect, useRef } from "react";

/**
 * On-screen signature (plan 04, B5, B11). The drawing is written as a PNG data URL into a
 * hidden input, which the form's server action stores as an attachment.
 */
export function SignaturePad({ name, clearLabel }: { name: string; clearLabel: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const point = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [
        ((e.clientX - r.left) * c.width) / r.width,
        ((e.clientY - r.top) * c.height) / r.height,
      ] as const;
    };
    const down = (e: PointerEvent) => {
      drawing.current = true;
      ctx.beginPath();
      ctx.moveTo(...point(e));
    };
    const move = (e: PointerEvent) => {
      if (!drawing.current) return;
      ctx.lineTo(...point(e));
      ctx.stroke();
    };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      input.current!.value = c.toDataURL("image/png");
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const clear = () => {
    const c = canvas.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    input.current!.value = "";
  };

  return (
    <div className="signature">
      <canvas ref={canvas} width={600} height={220} data-testid="signature" />
      <input ref={input} type="hidden" name={name} required />
      <button type="button" onClick={clear}>
        {clearLabel}
      </button>
    </div>
  );
}
