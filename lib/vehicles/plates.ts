// Plates are dated history for display and search, never identity (spec 00, section 3a).

// The same characters Postgres removes in vehicle_plates.plate_normalized:
// upper(regexp_replace(plate_display, '[[:space:]-]', '', 'g')).
// Search normalizes in SQL with that expression; this function is for display
// and comparisons in code, and tests/db/plates checks the two agree.
const STRIPPED = /[ \t\n\v\f\r-]/g;

/** "90-JG-526" -> "90JG526". */
export function normalizePlate(display: string): string {
  return display.replace(STRIPPED, "").toUpperCase();
}
