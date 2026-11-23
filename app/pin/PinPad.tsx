"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/app/_ui/Icon";

const ZERO = "0";

/**
 * 1.2 PIN: on the left the person, dots for the digits entered and any error; on the right
 * a keypad with delete and enter (the tick).
 */
export function PinPad({
  error,
  head,
  foot,
}: {
  error: boolean;
  head: ReactNode;
  foot: ReactNode;
}) {
  const t = useTranslations("auth");
  const [pin, setPin] = useState("");
  const press = (d: string) => setPin((p) => (p.length < 6 ? p + d : p));
  const dots = Math.max(4, pin.length);
  return (
    <div className="pin">
      <div className="pin-who">
        {head}
        <label className="visually-hidden">
          {t("pin")}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
          />
        </label>
        <span className={error && pin === "" ? "pin-dots error" : "pin-dots"} aria-hidden="true">
          {Array.from({ length: dots }, (_, i) => (
            <span key={i} className={i < pin.length ? "on" : undefined} />
          ))}
        </span>
        {foot}
      </div>
      <input type="hidden" name="pin" value={pin} />
      <div className="keypad" data-testid="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className="key" onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button
          type="button"
          className="key"
          aria-label={t("deleteDigit")}
          onClick={() => setPin((p) => p.slice(0, -1))}
        >
          <Icon name="backspace" size={28} />
        </button>
        <button type="button" className="key" onClick={() => press(ZERO)}>
          {ZERO}
        </button>
        <button
          type="submit"
          className="key go"
          aria-label={t("signInPin")}
          disabled={pin.length < 4}
        >
          <Icon name="check" size={30} stroke={2.4} />
        </button>
      </div>
    </div>
  );
}
