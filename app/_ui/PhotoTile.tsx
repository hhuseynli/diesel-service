"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "./Icon";

/**
 * A camera tile (Komponent · Foto yeri): empty (dashed, "Çəkmək üçün toxunun"), then the
 * photo with a green border and a tick. The file input is inside the label, named by it.
 * Camera only: `capture` opens the camera, not the gallery (spec 00, section 8).
 */
export function PhotoTile({
  name,
  label,
  hint,
  accept = "image/jpeg,image/png",
  required = false,
  multiple = false,
  width,
  height,
  onPick,
}: {
  name: string;
  label: string;
  hint: string;
  accept?: string;
  required?: boolean;
  multiple?: boolean;
  width?: number;
  height?: number;
  onPick?: (count: number) => void;
}) {
  const t = useTranslations("ui");
  const [preview, setPreview] = useState<string | null>(null);
  const [video, setVideo] = useState(false);
  const [count, setCount] = useState(0);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const style = {
    "--w": width ? `${width}px` : undefined,
    "--h": height ? `${height}px` : undefined,
  } as CSSProperties;

  return (
    <label className={count > 0 ? "tile done" : "tile"} style={style}>
      <input
        className="visually-hidden"
        type="file"
        aria-label={label}
        name={name}
        accept={accept}
        capture="environment"
        required={required}
        multiple={multiple}
        onChange={(e) => {
          const files = e.currentTarget.files;
          const first = files?.[0];
          setCount(files?.length ?? 0);
          setVideo(Boolean(first?.type.startsWith("video/")));
          setPreview(first?.type.startsWith("image/") ? URL.createObjectURL(first) : null);
          onPick?.(files?.length ?? 0);
        }}
      />
      {count === 0 ? (
        <>
          <Icon name="camera" size={30} />
          <span className="tile-label">{label}</span>
          <span className="tile-hint" aria-hidden="true">
            {hint}
          </span>
        </>
      ) : (
        <>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview (blob URL)
            <img src={preview} alt="" aria-hidden="true" />
          ) : (
            <Icon name={video ? "video" : "image"} size={34} stroke={1.8} />
          )}
          <span className="tile-caption" aria-hidden="true">
            <span>{label}</span>
            {count > 1 && <span className="muted">{t("times", { n: count })}</span>}
          </span>
          <span className="tile-check" aria-hidden="true">
            <Icon name="check" size={16} stroke={3} />
          </span>
        </>
      )}
    </label>
  );
}
