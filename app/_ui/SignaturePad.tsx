"use client";

import { useEffect, useRef } from "react";

/**
 * On-screen signature (plan 04, B5, B11). The drawing is written as a PNG data URL into a
 * hidden input, which the form's server action stores as an attachment.
 */
export function SignaturePad({
  name,
  label,
  clearLabel,
  invalid = false,
}: {
  name: string;
  label: string;
  clearLabel: string;
  invalid?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    // Draw at the canvas's real size, so strokes land under the finger.
    const box = c.getBoundingClientRect();
    c.width = Math.round(box.width);
    c.height = Math.round(box.height);
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1f274f";
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
      <span className="label-row">
        <span className="label">{label}</span>
        <button type="button" className="btn sm" onClick={clear}>
          {clearLabel}
        </button>
      </span>
      <canvas
        ref={canvas}
        data-testid="signature"
        aria-label={label}
        style={invalid ? { borderColor: "var(--err)", borderWidth: 1.5 } : undefined}
      />
      <input ref={input} type="hidden" name={name} />
    </div>
  );
}
