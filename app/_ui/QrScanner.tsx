"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";

// The scan pad (2.1 Maşını tap): the browser's BarcodeDetector (tablet Chrome) reads the
// sticker inside the frame; the typed code beside it is the fallback (plan 04, B3). On a
// hit the token goes into the form's input and the form is submitted.

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

const noSubscribe = () => () => {};

export function QrScanner({
  formId,
  inputName,
  title,
  sub,
  startLabel,
  unsupported,
}: {
  formId: string;
  inputName: string;
  title: string;
  sub: string;
  startLabel: string;
  unsupported: string;
}) {
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
          const form = document.getElementById(formId) as HTMLFormElement;
          (form.elements.namedItem(inputName) as HTMLInputElement).value = hit.rawValue;
          // One scan per tap: the camera goes off, and "scan" is offered again if needed.
          stream.getTracks().forEach((t) => t.stop());
          setActive(false);
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
  }, [active, formId, inputName]);

  return (
    <div className="scan-pad">
      <span className="scan-frame">
        <i />
        <i />
        <i />
        <i />
        {active && <video ref={video} muted playsInline />}
      </span>
      <span className="h-card">{title}</span>
      <span className="scan-sub">{supported ? sub : unsupported}</span>
      {supported && !active && (
        <button type="button" className="btn outline-light" onClick={() => setActive(true)}>
          <Icon name="qr" size={22} />
          {startLabel}
        </button>
      )}
    </div>
  );
}
