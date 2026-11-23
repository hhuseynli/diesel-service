"use client";

import { Icon } from "./Icon";

export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="btn primary lg block no-print" onClick={() => window.print()}>
      <Icon name="printer" />
      {label}
    </button>
  );
}
