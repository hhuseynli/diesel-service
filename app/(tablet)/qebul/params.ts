// The intake keeps its step in the URL (plan 04, C4):
//   m   identify mode (code, vin, plate)   pl  plate search      nv  a new VIN
//   v   vehicle      ok  VIN confirmed      nw  new vehicle (VIN typed from the car)
//   ch  plate change open                   pc  plate moved notice  rs  replaced sticker
//   c   client       q   client search      new client form open
//   oc  owner changed   cd  contract decision   go  client step done
//   p   the six photo ids   km, r  odometer and its reason   e  refusal key
export type Params = Record<string, string | undefined>;

/** /qebul with the current step plus `extra`; `undefined` removes a key. */
export function href(params: Params, extra: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, val] of Object.entries({ ...params, ...extra })) {
    if (val !== undefined && k !== "e") q.set(k, val);
  }
  const s = q.toString();
  return s ? `/qebul?${s}` : "/qebul";
}
