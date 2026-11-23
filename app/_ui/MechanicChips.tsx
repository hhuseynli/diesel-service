import { Icon } from "./Icon";

/** Choose the mechanic for this action (R3): one chip per mechanic, the job's preselected. */
export function MechanicChips({
  staff,
  selected,
  required = true,
}: {
  staff: { id: string; name: string }[];
  selected: string | null;
  required?: boolean;
}) {
  const preselected = selected ?? (staff.length === 1 ? staff[0]!.id : null);
  return (
    <div className="chips">
      {staff.map((m) => (
        <label key={m.id} className="chip">
          <input
            type="radio"
            name="mechanicId"
            value={m.id}
            defaultChecked={m.id === preselected}
            required={required}
          />
          <Icon name="check" size={16} stroke={2.4} />
          {m.name}
        </label>
      ))}
    </div>
  );
}
