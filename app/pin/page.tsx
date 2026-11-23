import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Brand } from "@/app/_ui/Brand";
import { Icon } from "@/app/_ui/Icon";
import { pinCandidates } from "@/lib/auth";
import { getDeviceToken } from "@/lib/auth/context";
import { getDb } from "@/lib/db/client";
import { pinAction } from "../actions";
import { signInError } from "../sign-in-errors";
import { PinPad } from "./PinPad";

// The shared tablet (spec 01, section 1; design 1.1-1.3): "Kimsiniz?" lists who may switch
// in by PIN; tapping a person opens the keypad. Every action is the PIN holder's.
export default async function PinPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; u?: string }>;
}) {
  const t = await getTranslations("auth");
  const tr = await getTranslations("roles");
  const { e, u } = await searchParams;
  const error = signInError(e);

  if (!(await getDeviceToken())) {
    return (
      <main className="screen">
        <div className="centered">
          <div className="card narrow center">
            <span className="round-icon">
              <Icon name="device" size={36} />
            </span>
            <h1 className="h-screen">{t("notTabletTitle")}</h1>
            <p className="muted">{t("notTablet")}</p>
            <Link href="/giris" className="btn outline lg">
              {t("officeLink")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const staff = await pinCandidates(getDb());
  const person = u ? staff.find((s) => s.id === u) : undefined;

  if (!person) {
    return (
      <main className="screen">
        <div className="centered">
          <div className="card">
            <Brand large />
            <h1 className="h-screen">{t("who")}</h1>
            {error && error !== "INVALID" && (
              <p className="error-text" role="alert">
                {t(`errors.${error}`)}
              </p>
            )}
            {staff.length === 0 && <p className="muted">{t("noStaff")}</p>}
            <div className="people">
              {staff.map((s) => (
                <Link key={s.id} href={`/pin?u=${s.id}`} className="person">
                  <span className="avatar lg" aria-hidden="true">
                    {s.name.slice(0, 1)}
                  </span>
                  <span className="who">
                    <strong>{s.name}</strong>
                    <small>{tr(s.role)}</small>
                  </span>
                </Link>
              ))}
            </div>
            <span className="small muted">{t("attribution")}</span>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <form action={pinAction} className="screen">
        <input type="hidden" name="userId" value={person.id} />
        <PinPad
          error={Boolean(error)}
          head={
            <>
              <span className="avatar xl" aria-hidden="true">
                {person.name.slice(0, 1)}
              </span>
              <h1 className="h-card">{person.name}</h1>
              <span className="muted">{tr(person.role)}</span>
              <span style={{ marginTop: 16 }}>{t("enterPin")}</span>
            </>
          }
          foot={
            <>
              {error && (
                <p className="error-text" role="alert">
                  {error === "INVALID" ? t("pinWrong") : t(`errors.${error}`)}
                </p>
              )}
              <Link href="/pin" className="btn">
                {t("otherUser")}
              </Link>
            </>
          }
        />
      </form>
    </main>
  );
}
