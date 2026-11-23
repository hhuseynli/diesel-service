"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// The browser's BarcodeDetector (tablet Chrome) reads the sticker; the typed code is the
// fallback (plan 04, B3). On a hit the token is put in the form's input and submitted.

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

const noSubscribe = () => () => {};

export function QrScanner({ inputName, scanLabel }: { inputName: string; scanLabel: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  // Known only in the browser; the server snapshot (false) keeps hydration consistent.
  const supported = useSyncExternalStore(
    noSubscribe,
    () => "BarcodeDetector" in window,
    () => false,
  );

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | undefined;
    let stopped = false;
    const Ctor = (window as unknown as { BarcodeDetector: new (o: object) => Detector })
      .BarcodeDetector;
    const detector = new Ctor({ formats: ["qr_code"] });
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      // Closed while the camera was starting: turn it off again at once.
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play();
      while (!stopped) {
        const [hit] = await detector.detect(v).catch(() => []);
        if (hit) {
          const form = v.closest("form")!;
          (form.elements.namedItem(inputName) as HTMLInputElement).value = hit.rawValue;
          form.requestSubmit();
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })().catch(() => {
      // No camera, or permission refused: the typed sticker code still works.
      setActive(false);
    });
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active, inputName]);

  if (!supported) return null;
  return (
    <div>
      {active ? (
        <video ref={video} muted playsInline className="scanner" />
      ) : (
        <button type="button" onClick={() => setActive(true)}>
          {scanLabel}
        </button>
      )}
    </div>
  );
}
