import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db/types";
import type { JobStatus } from "@/lib/jobs/types";
import type { Role } from "@/lib/users/roles";

// Read models for the tablet screens (spec 01, section 3). Reads only.

/** The signed-in person for the tablet bar: name and their first role. */
export async function staffMember(
  db: Db | Tx,
  userId: string,
): Promise<{ name: string; role: Role | null }> {
  const { rows } = await db.execute<{ name: string; role: Role | null }>(sql`
    SELECT u.full_name AS name,
           (SELECT r.role FROM user_roles r WHERE r.user_id = u.id AND r.revoked_at IS NULL
             ORDER BY array_position(ARRAY['OWNER', 'MANAGEMENT', 'FORMEN', 'WAREHOUSEMAN',
                                           'CASHIER', 'BOOKKEEPER', 'MECHANIC'], r.role)
             LIMIT 1) AS role
      FROM users u WHERE u.id = ${userId}`);
  return rows[0] ?? { name: "", role: null };
}

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
  minutesInStatus: number;
  late: boolean;
}

/**
 * Open jobs for the board, longest waiting first; a card is late after
 * `job_board_amber_hours` in the same status.
 */
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
    minutes: number;
    amber_hours: number;
  }>(sql`
    SELECT j.id, j.number, j.status, v.make, v.model, v.vin, vp.plate_display AS plate,
           c.name AS client, m.full_name AS mechanic,
           floor(extract(epoch FROM now() - (SELECT max(e.at) FROM job_status_events e
                                              WHERE e.job_order_id = j.id)) / 60)::int AS minutes,
           coalesce((SELECT (s.value #>> '{}')::int FROM settings s
                      WHERE s.key = 'job_board_amber_hours' AND s.effective_from <= now()
                      ORDER BY s.effective_from DESC LIMIT 1), 24) AS amber_hours
      FROM job_orders j
      JOIN vehicles v ON v.id = j.vehicle_id
      JOIN contragents c ON c.id = j.contragent_id
      LEFT JOIN vehicle_plates vp ON vp.vehicle_id = v.id AND vp.status = 'ACTIVE'
      LEFT JOIN users m ON m.id = j.mechanic_id
     WHERE j.status NOT IN ('BAGLANDI', 'LEGV') AND NOT j.car_released
     ORDER BY minutes DESC`);
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
    minutesInStatus: r.minutes,
    late: r.minutes >= r.amber_hours * 60,
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

export interface LastVisit {
  clientId: string;
  clientName: string;
  at: string;
  km: number | null;
  frontPhotoId: string | null;
}

/** The vehicle's last job: its client, date, odometer and front photo (3.2, 3.3). */
export async function lastVisit(db: Db | Tx, vehicleId: string): Promise<LastVisit | null> {
  const { rows } = await db.execute<{
    client_id: string;
    client_name: string;
    at: string;
    km: number | null;
    front_photo_id: string | null;
  }>(sql`
    SELECT j.contragent_id AS client_id, c.name AS client_name, j.created_at::text AS at,
           (SELECT r.value_km FROM odometer_readings r WHERE r.job_order_id = j.id) AS km,
           (SELECT p.attachment_id FROM intake_photos p
             WHERE p.job_order_id = j.id AND p.slot = 'FRONT') AS front_photo_id
      FROM job_orders j JOIN contragents c ON c.id = j.contragent_id
     WHERE j.vehicle_id = ${vehicleId}
     ORDER BY j.created_at DESC LIMIT 1`);
  const r = rows[0];
  return r
    ? {
        clientId: r.client_id,
        clientName: r.client_name,
        at: r.at,
        km: r.km,
        frontPhotoId: r.front_photo_id,
      }
    : null;
}

/** The vehicle's last odometer reading and when it was taken. */
export async function lastReading(
  db: Db | Tx,
  vehicleId: string,
): Promise<{ km: number; at: string } | null> {
  const { rows } = await db.execute<{ km: number; at: string }>(sql`
    SELECT value_km AS km, created_at::text AS at FROM odometer_readings
     WHERE vehicle_id = ${vehicleId} ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

export type ClientSummary = {
  id: string;
  name: string;
  kind: "FIZIKI" | "HUQUQI";
  voen: string | null;
  phone: string | null;
};

export async function clientSummary(
  db: Db | Tx,
  contragentId: string,
): Promise<ClientSummary | null> {
  const { rows } = await db.execute<ClientSummary>(sql`
    SELECT id, name, kind, voen, phone FROM contragents WHERE id = ${contragentId}`);
  return rows[0] ?? null;
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

export interface ContractSummary {
  number: string;
  validFrom: string;
  validTo: string | null;
  /** The plate the contract lists for this vehicle, if it is on it. */
  contractPlate: string | null;
}

export async function contractSummary(
  db: Db | Tx,
  contractId: string,
  vehicleId: string,
): Promise<ContractSummary | null> {
  const { rows } = await db.execute<{
    number: string;
    valid_from: string;
    valid_to: string | null;
    contract_plate: string | null;
  }>(sql`
    SELECT c.number, c.valid_from::text, c.valid_to::text,
           (SELECT cv.contract_plate FROM contract_vehicles cv
             WHERE cv.contract_id = c.id AND cv.vehicle_id = ${vehicleId}
             ORDER BY cv.added_on DESC LIMIT 1) AS contract_plate
      FROM contracts c WHERE c.id = ${contractId}`);
  const r = rows[0];
  return r
    ? {
        number: r.number,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        contractPlate: r.contract_plate,
      }
    : null;
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
  minutesInStatus: number;
  vehicleId: string;
  vehicle: string;
  vin: string;
  plate: string | null;
  client: string;
  contractNumber: string | null;
  driver: string | null;
  intakeKm: number | null;
  receivedBy: string;
  receivedAt: string;
  mechanic: string | null;
  mechanicId: string | null;
  complaints: string | null;
  cancel: { reason: string; by: string; at: string } | null;
  findings: {
    id: string;
    description: string;
    mechanic: string;
    recordedBy: string;
    at: string;
    additional: boolean;
    attachments: { id: string; video: boolean }[];
    /** Set on a correction: the finding it corrects and why. */
    correctsId: string | null;
    correctionReason: string | null;
  }[];
  services: { id: string; description: string; additional: boolean }[];
  parts: {
    id: string;
    description: string;
    quantity: string;
    unitHint: string | null;
    status: string;
    additional: boolean;
  }[];
  removedParts: {
    id: string;
    description: string;
    disposition: string;
    mechanic: string | null;
    at: string;
  }[];
  qualityCheck: { mechanic: string | null; checkedBy: string; at: string } | null;
  handover: { number: string; signerName: string; signerPhone: string; at: string } | null;
}

export async function jobCard(db: Db | Tx, jobId: string): Promise<JobCard | null> {
  const { rows } = await db.execute<{
    id: string;
    number: string;
    status: JobStatus;
    minutes: number;
    vehicle_id: string;
    make: string | null;
    model: string | null;
    vin: string;
    plate: string | null;
    client: string;
    contract_number: string | null;
    driver: string | null;
    intake_km: number | null;
    received_by: string;
    received_at: string;
    mechanic: string | null;
    mechanic_id: string | null;
    complaints: string | null;
    cancel_reason: string | null;
    cancelled_by: string | null;
    cancelled_at: string | null;
  }>(sql`
    SELECT j.id, j.number, j.status, j.vehicle_id, v.make, v.model, j.vin_snapshot AS vin,
           coalesce(vp.plate_display, j.plate_snapshot) AS plate, c.name AS client,
           k.number AS contract_number, ic.signer_name AS driver, r.value_km AS intake_km,
           rb.full_name AS received_by, j.created_at::text AS received_at,
           m.full_name AS mechanic, j.mechanic_id, j.complaints, j.cancel_reason,
           floor(extract(epoch FROM now() - (SELECT max(e.at) FROM job_status_events e
                                              WHERE e.job_order_id = j.id)) / 60)::int AS minutes,
           (SELECT u.full_name FROM job_status_events e JOIN users u ON u.id = e.user_id
             WHERE e.job_order_id = j.id AND e.to_status = 'LEGV' LIMIT 1) AS cancelled_by,
           (SELECT e.at::text FROM job_status_events e
             WHERE e.job_order_id = j.id AND e.to_status = 'LEGV' LIMIT 1) AS cancelled_at
      FROM job_orders j
      JOIN vehicles v ON v.id = j.vehicle_id
      JOIN contragents c ON c.id = j.contragent_id
      JOIN users rb ON rb.id = j.created_by
      LEFT JOIN vehicle_plates vp ON vp.vehicle_id = v.id AND vp.status = 'ACTIVE'
      LEFT JOIN contracts k ON k.id = j.contract_id
      LEFT JOIN intake_confirmations ic ON ic.job_order_id = j.id
      LEFT JOIN odometer_readings r ON r.job_order_id = j.id
      LEFT JOIN users m ON m.id = j.mechanic_id
     WHERE j.id = ${jobId}`);
  const j = rows[0];
  if (!j) return null;

  const findings = await db.execute<{
    id: string;
    description: string;
    mechanic: string;
    recorded_by: string;
    at: string;
    additional: boolean;
    attachments: { id: string; video: boolean }[];
    corrects_id: string | null;
    correction_reason: string | null;
  }>(sql`
    SELECT f.id, f.description, u.full_name AS mechanic, cb.full_name AS recorded_by,
           f.created_at::text AS at, f.additional, f.corrects_id, f.correction_reason,
           coalesce((SELECT json_agg(json_build_object('id', a.attachment_id,
                                                       'video', att.mime_type LIKE 'video/%')
                                     ORDER BY a.created_at)
                       FROM inspection_finding_attachments a
                       JOIN attachments att ON att.id = a.attachment_id
                      WHERE a.finding_id = f.id), '[]') AS attachments
      FROM inspection_findings f
      JOIN users u ON u.id = f.mechanic_id
      JOIN users cb ON cb.id = f.created_by
     WHERE f.job_order_id = ${jobId} ORDER BY f.created_at`);
  const services = await db.execute<{ id: string; description: string; additional: boolean }>(
    sql`SELECT id, description, additional FROM planned_services
         WHERE job_order_id = ${jobId} ORDER BY created_at`,
  );
  const parts = await db.execute<{
    id: string;
    description: string;
    quantity: string;
    unit_hint: string | null;
    status: string;
    additional: boolean;
  }>(
    sql`SELECT id, description, quantity::text, unit_hint, status, additional FROM parts_requests
         WHERE job_order_id = ${jobId} ORDER BY created_at`,
  );
  const removed = await db.execute<{
    id: string;
    description: string;
    disposition: string;
    mechanic: string | null;
    at: string;
  }>(sql`
    SELECT r.id, r.description, r.disposition, u.full_name AS mechanic, r.created_at::text AS at
      FROM removed_parts r LEFT JOIN users u ON u.id = r.mechanic_id
     WHERE r.job_order_id = ${jobId} ORDER BY r.created_at`);
  const qc = await db.execute<{ mechanic: string | null; checked_by: string; at: string }>(sql`
    SELECT u.full_name AS mechanic, cb.full_name AS checked_by, q.created_at::text AS at
      FROM quality_checks q
      LEFT JOIN users u ON u.id = q.mechanic_id
      JOIN users cb ON cb.id = q.created_by
     WHERE q.job_order_id = ${jobId} AND q.passed
     ORDER BY q.created_at DESC LIMIT 1`);
  const handover = await db.execute<{
    number: string;
    signer_name: string;
    signer_phone: string;
    at: string;
  }>(sql`
    SELECT d.number, s.signer_name, s.signer_phone, s.created_at::text AS at
      FROM documents d JOIN document_signatures s ON s.document_id = d.id
     WHERE d.job_order_id = ${jobId} AND d.type = 'TEHVIL_TESLIM' AND d.status IN ('APPROVED', 'POSTED')
     ORDER BY s.created_at DESC LIMIT 1`);

  return {
    id: j.id,
    number: j.number,
    status: j.status,
    minutesInStatus: j.minutes,
    vehicleId: j.vehicle_id,
    vehicle: [j.make, j.model].filter(Boolean).join(" "),
    vin: j.vin,
    plate: j.plate,
    client: j.client,
    contractNumber: j.contract_number,
    driver: j.driver,
    intakeKm: j.intake_km,
    receivedBy: j.received_by,
    receivedAt: j.received_at,
    mechanic: j.mechanic,
    mechanicId: j.mechanic_id,
    complaints: j.complaints,
    cancel:
      j.status === "LEGV" && j.cancel_reason
        ? { reason: j.cancel_reason, by: j.cancelled_by ?? "", at: j.cancelled_at ?? "" }
        : null,
    findings: findings.rows.map((f) => ({
      id: f.id,
      description: f.description,
      mechanic: f.mechanic,
      recordedBy: f.recorded_by,
      at: f.at,
      additional: f.additional,
      attachments: f.attachments,
      correctsId: f.corrects_id,
      correctionReason: f.correction_reason,
    })),
    services: services.rows,
    parts: parts.rows.map((p) => ({
      id: p.id,
      description: p.description,
      quantity: p.quantity,
      unitHint: p.unit_hint,
      status: p.status,
      additional: p.additional,
    })),
    removedParts: removed.rows,
    qualityCheck: qc.rows[0]
      ? { mechanic: qc.rows[0].mechanic, checkedBy: qc.rows[0].checked_by, at: qc.rows[0].at }
      : null,
    handover: handover.rows[0]
      ? {
          number: handover.rows[0].number,
          signerName: handover.rows[0].signer_name,
          signerPhone: handover.rows[0].signer_phone,
          at: handover.rows[0].at,
        }
      : null,
  };
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
