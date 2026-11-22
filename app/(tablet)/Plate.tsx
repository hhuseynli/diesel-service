/** A number plate drawn like the Azerbaijani one: a blue band (CSS) and the number. */
export function Plate({ value }: { value: string }) {
  return (
    <span className="plate">
      <span className="plate-band" aria-hidden="true" />
      <span className="plate-number">{value}</span>
    </span>
  );
}
