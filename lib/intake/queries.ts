import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db/types";
import type { JobStatus } from "@/lib/jobs/types";

// Read models for the tablet screens (spec 01, section 3). Reads only.

export interface BoardCard {
  id: string;
  number: string;
  status: JobStatus;
  make: string | null;
  model: string | null;
  vinLast6: string;
  plate: string | null;
  client: string;
  mechanic: string | null;
  hoursInStatus: number;
  amber: boolean;
}

/** Open jobs for the board, oldest first; cards turn amber after `job_board_amber_hours`. */
export async function boardCards(db: Db | Tx): Promise<BoardCard[]> {
  const { rows } = await db.execute<{
    id: string;
    number: string;
    status: JobStatus;
    make: string | null;
    model: string | null;
    vin: string;
    plate: string | null;
    client: string;
    mechanic: string | null;
    hours: number;
    amber_hours: number;
  }>(sql`
    SELECT j.id, j.number, j.status, v.make, v.model, v.vin, vp.plate_display AS plate,
           c.name AS client, m.full_name AS mechanic,
           floor(extract(epoch FROM now() - (SELECT max(e.at) FROM job_status_events e
                                              WHERE e.job_order_id = j.id)) / 3600)::int AS hours,
           coalesce((SELECT (s.value #>> '{}')::int FROM settings s
                      WHERE s.key = 'job_board_amber_hours' AND s.effective_from <= now()
                      ORDER BY s.effective_from DESC LIMIT 1), 24) AS amber_hours
      FROM job_orders j
      JOIN vehicles v ON v.id = j.vehicle_id
      JOIN contragents c ON c.id = j.contragent_id
      LEFT JOIN vehicle_plates vp ON vp.vehicle_id = v.id AND vp.status = 'ACTIVE'
      LEFT JOIN users m ON m.id = j.mechanic_id
     WHERE j.status NOT IN ('BAGLANDI', 'LEGV') AND NOT j.car_released
     ORDER BY j.created_at`);
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    make: r.make,
    model: r.model,
    vinLast6: r.vin.slice(-6),
    plate: r.plate,
    client: r.client,
    mechanic: r.mechanic,
    hoursInStatus: r.hours,
    amber: r.hours >= r.amber_hours,
  }));
}

export interface VehicleSummary {
  id: string;
  vin: string;
  make: string | null;
  model: string | null;
  year: number | null;
  plate: string | null;
  openJobId: string | null;
}

export async function vehicleSummary(
  db: Db | Tx,
  vehicleId: string,
): Promise<VehicleSummary | null> {
  const { rows } = await db.execute<{
    id: string;
    vin: string;
    make: string | null;
    model: string | null;
    year: number | null;
    plate: string | null;
    open_job_id: string | null;
  }>(sql`
    SELECT v.id, v.vin, v.make, v.model, v.year, vp.plate_display AS plate,
           (SELECT j.id FROM job_orders j
             WHERE j.vehicle_id = v.id AND j.status NOT IN ('BAGLANDI', 'LEGV') AND NOT j.car_released
             LIMIT 1) AS open_job_id
      FROM vehicles v
      LEFT JOIN vehicle_plates vp ON vp.vehicle_id = v.id AND vp.status = 'ACTIVE'
     WHERE v.id = ${vehicleId}`);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        vin: r.vin,
        make: r.make,
        model: r.model,
        year: r.year,
        plate: r.plate,
        openJobId: r.open_job_id,
      }
    : null;
}

export async function searchClients(
  db: Db | Tx,
  query: string,
): Promise<{ id: string; name: string; phone: string | null; voen: string | null }[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const { rows } = await db.execute<{
    id: string;
    name: string;
    phone: string | null;
    voen: string | null;
  }>(sql`
    SELECT id, name, phone, voen FROM contragents
     WHERE is_customer AND is_active
       AND (name ILIKE '%' || ${q} || '%' OR phone LIKE '%' || ${q} || '%' OR voen = ${q})
     ORDER BY name LIMIT 20`);
  return rows;
}

export async function mechanics(db: Db | Tx): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.execute<{ id: string; name: string }>(sql`
    SELECT u.id, u.full_name AS name FROM users u
     WHERE u.is_active AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id
                                     AND r.role = 'MECHANIC' AND r.revoked_at IS NULL)
     ORDER BY u.full_name`);
  return rows;
}

export interface JobCard {
  id: string;
  number: string;
  status: JobStatus;
  vehicleId: string;
  vehicle: string;
  vin: string;
  plate: string | null;
  client: string;
  mechanic: string | null;
  mechanicId: string | null;
  complaints: string | null;
  findings: {
    id: string;
    description: string;
    mechanic: string;
    additional: boolean;
    attachmentIds: string[];
    /** Set on a correction: the finding it corrects and why. */
    correctsId: string | null;
    correctionReason: string | null;
  }[];
  services: { id: string; description: string }[];
  parts: {
    id: string;
    description: string;
    quantity: string;
    unitHint: string | null;
    status: string;
  }[];
  removedParts: { id: string; description: string; disposition: string }[];
}

export async function jobCard(db: Db | Tx, jobId: string): Promise<JobCard | null> {
  const { rows } = await db.execute<{
    id: string;
    number: string;
    status: JobStatus;
    vehicle_id: string;
    make: string | null;
    model: string | null;
    vin: string;
    plate: string | null;
    client: string;
    mechanic: string | null;
    mechanic_id: string | null;
    complaints: string | null;
  }>(sql`
    SELECT j.id, j.number, j.status, j.vehicle_id, v.make, v.model, j.vin_snapshot AS vin,
           j.plate_snapshot AS plate, c.name AS client, m.full_name AS mechanic, j.mechanic_id, j.complaints
      FROM job_orders j
      JOIN vehicles v ON v.id = j.vehicle_id
      JOIN contragents c ON c.id = j.contragent_id
      LEFT JOIN users m ON m.id = j.mechanic_id
     WHERE j.id = ${jobId}`);
  const j = rows[0];
  if (!j) return null;
  const findings = await db.execute<{
    id: string;
    description: string;
    mechanic: string;
    additional: boolean;
    attachment_ids: string[];
    corrects_id: string | null;
    correction_reason: string | null;
  }>(sql`
    SELECT f.id, f.description, u.full_name AS mechanic, f.additional, f.corrects_id,
           f.correction_reason,
           array(SELECT a.attachment_id::text FROM inspection_finding_attachments a
                  WHERE a.finding_id = f.id ORDER BY a.created_at) AS attachment_ids
      FROM inspection_findings f JOIN users u ON u.id = f.mechanic_id
     WHERE f.job_order_id = ${jobId} ORDER BY f.created_at`);
  const services = await db.execute<{ id: string; description: string }>(
    sql`SELECT id, description FROM planned_services WHERE job_order_id = ${jobId} ORDER BY created_at`,
  );
  const parts = await db.execute<{
    id: string;
    description: string;
    quantity: string;
    unit_hint: string | null;
    status: string;
  }>(
    sql`SELECT id, description, quantity::text, unit_hint, status FROM parts_requests
         WHERE job_order_id = ${jobId} ORDER BY created_at`,
  );
  const removed = await db.execute<{ id: string; description: string; disposition: string }>(
    sql`SELECT id, description, disposition FROM removed_parts WHERE job_order_id = ${jobId} ORDER BY created_at`,
  );
  return {
    id: j.id,
    number: j.number,
    status: j.status,
    vehicleId: j.vehicle_id,
    vehicle: [j.make, j.model].filter(Boolean).join(" "),
    vin: j.vin,
    plate: j.plate,
    client: j.client,
    mechanic: j.mechanic,
    mechanicId: j.mechanic_id,
    complaints: j.complaints,
    findings: findings.rows.map((f) => ({
      id: f.id,
      description: f.description,
      mechanic: f.mechanic,
      additional: f.additional,
      attachmentIds: f.attachment_ids,
      correctsId: f.corrects_id,
      correctionReason: f.correction_reason,
    })),
    services: services.rows,
    parts: parts.rows.map((p) => ({ ...p, unitHint: p.unit_hint })),
    removedParts: removed.rows,
  };
}

export async function clientName(db: Db | Tx, contragentId: string): Promise<string | null> {
  const { rows } = await db.execute<{ name: string }>(
    sql`SELECT name FROM contragents WHERE id = ${contragentId}`,
  );
  return rows[0]?.name ?? null;
}

/** The vehicle's last odometer reading in km, if any. */
export async function lastOdometer(db: Db | Tx, vehicleId: string): Promise<number | null> {
  const { rows } = await db.execute<{ value_km: number }>(sql`
    SELECT value_km FROM odometer_readings WHERE vehicle_id = ${vehicleId}
     ORDER BY created_at DESC LIMIT 1`);
  return rows[0]?.value_km ?? null;
}

export interface OdometerAlert {
  jobId: string;
  number: string;
  vin: string;
  valueKm: number;
  belowPrevious: boolean;
  reason: string | null;
}

/**
 * Odometer readings flagged in the last 30 days, newest first, for the owner (R9; plan 04,
 * B6). Sending them as messages comes with the outbox (milestone 6).
 */
export async function odometerAlerts(db: Db | Tx): Promise<OdometerAlert[]> {
  const { rows } = await db.execute<{
    job_id: string;
    number: string;
    vin: string;
    value_km: number;
    below_previous: boolean;
    reason: string | null;
  }>(sql`
    SELECT j.id AS job_id, j.number, j.vin_snapshot AS vin, r.value_km, r.below_previous, r.reason
      FROM odometer_readings r JOIN job_orders j ON j.id = r.job_order_id
     WHERE (r.below_previous OR r.above_daily_limit) AND r.created_at > now() - interval '30 days'
     ORDER BY r.created_at DESC LIMIT 50`);
  return rows.map((r) => ({
    jobId: r.job_id,
    number: r.number,
    vin: r.vin,
    valueKm: r.value_km,
    belowPrevious: r.below_previous,
    reason: r.reason,
  }));
}

/** The FRONT intake photo from the vehicle's last visit, to compare at the VIN check (3.2). */
export async function lastVisitPhoto(db: Db | Tx, vehicleId: string): Promise<string | null> {
  const { rows } = await db.execute<{ attachment_id: string }>(sql`
    SELECT p.attachment_id FROM intake_photos p JOIN job_orders j ON j.id = p.job_order_id
     WHERE j.vehicle_id = ${vehicleId} AND p.slot = 'FRONT'
     ORDER BY j.created_at DESC LIMIT 1`);
  return rows[0]?.attachment_id ?? null;
}
