"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/**
 * A camera tile: the file input sits inside its label, so the label is the tap target and
 * the input's accessible name. After a shot the tile shows the photo and a tick.
 */
export function PhotoInput({
  name,
  label,
  hint,
  accept = "image/jpeg,image/png",
  required = false,
  multiple = false,
}: {
  name: string;
  label: string;
  hint: string;
  accept?: string;
  required?: boolean;
  multiple?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  return (
    <label className={preview ? "photo-tile done" : "photo-tile"}>
      <input
        className="visually-hidden"
        type="file"
        name={name}
        accept={accept}
        capture="environment"
        required={required}
        multiple={multiple}
        onChange={(e) => {
          const files = e.currentTarget.files;
          setCount(files?.length ?? 0);
          const first = files?.[0];
          setPreview(first && first.type.startsWith("image/") ? URL.createObjectURL(first) : null);
        }}
      />
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local preview (blob URL)
        <img src={preview} alt="" aria-hidden="true" />
      ) : (
        <span className="photo-tile-icon" aria-hidden="true">
          <Icon name="camera" size={28} />
        </span>
      )}
      <span className="photo-tile-label">{label}</span>
      <span className="photo-tile-hint" aria-hidden="true">
        {count > 0 ? <Icon name="check" size={16} /> : hint}
        {count > 1 ? ` ×${count}` : null}
      </span>
    </label>
  );
}
