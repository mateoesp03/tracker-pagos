// api/sync-payments.js
// Sincroniza la tabla fixed_payments con Google Calendar:
// - Pago nuevo  -> crea evento recurrente mensual
// - Pago editado -> actualiza titulo, monto y/o dia de cobro
// - Pago desactivado o borrado -> elimina el evento

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TZ = "America/Lima";

async function getAccessToken() {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Guarda el id del evento en la fila del pago
async function saveEventId(paymentId, eventId) {
  await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/fixed_payments?id=eq.${paymentId}`,
    {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ calendar_event_id: eventId }),
    }
  );
}

function formatMonto(monto, moneda) {
  const n = Number(monto);
  return moneda === "USD" ? `US$${n}` : `S/${n}`;
}

function titulo(pago) {
  return `Pagar ${pago.nombre} - ${formatMonto(pago.monto, pago.moneda)}`;
}

// Primera fecha futura que caiga en el dia de cobro
function proximaFecha(dia) {
  const hoy = new Date();
  let year = hoy.getFullYear();
  let month = hoy.getMonth();
  if (hoy.getDate() >= dia) month += 1;
  const d = new Date(Date.UTC(year, month, dia));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const RECORDATORIOS = {
  useDefault: false,
  overrides: [
    { method: "popup", minutes: 4320 },
    { method: "popup", minutes: 0 },
  ],
};

function cuerpoEvento(pago) {
  // Pago de una sola vez: evento suelto en su fecha, sin repeticion
  if (pago.tipo === "unico" && pago.fecha_unica) {
    return {
      summary: titulo(pago),
      start: { dateTime: `${pago.fecha_unica}T09:00:00`, timeZone: TZ },
      end: { dateTime: `${pago.fecha_unica}T09:15:00`, timeZone: TZ },
      recurrence: null,
      reminders: RECORDATORIOS,
    };
  }
  const fecha = proximaFecha(pago.dia_cobro);
  return {
    summary: titulo(pago),
    start: { dateTime: `${fecha}T09:00:00`, timeZone: TZ },
    end: { dateTime: `${fecha}T09:15:00`, timeZone: TZ },
    recurrence: [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${pago.dia_cobro}`],
    reminders: RECORDATORIOS,
  };
}

// Deja constancia en la base para que la app pueda avisar
async function registrarError(contexto, mensaje) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/sync_errors`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ contexto, mensaje: String(mensaje).slice(0, 500) }),
    });
  } catch (_) {}
}

async function crearEvento(token, pago) {
  const res = await fetch(CAL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cuerpoEvento(pago)),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`crear: ${JSON.stringify(data)}`);
  return data.id;
}

async function actualizarEvento(token, eventId, pago, cambioDia) {
  // Si cambio el dia hay que reescribir fechas y recurrencia; si no, solo el titulo
  const body = cambioDia ? cuerpoEvento(pago) : { summary: titulo(pago) };
  const res = await fetch(`${CAL_API}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`actualizar: ${await res.text()}`);
}

async function borrarEvento(token, eventId) {
  const res = await fetch(`${CAL_API}/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 410 = ya estaba borrado, lo damos por bueno
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`borrar: ${await res.text()}`);
  }
}

export default async function handler(req, res) {
  if (req.headers["x-webhook-secret"] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    const { type, record, old_record } = req.body;
    const token = await getAccessToken();

    // --- Pago borrado de la tabla ---
    if (type === "DELETE") {
      if (old_record?.calendar_event_id) {
        await borrarEvento(token, old_record.calendar_event_id);
      }
      return res.status(200).json({ ok: true, accion: "evento borrado" });
    }

    // --- Pago nuevo ---
    if (type === "INSERT") {
      if (!record.activo) {
        return res.status(200).json({ skipped: "pago inactivo" });
      }
      const eventId = await crearEvento(token, record);
      await saveEventId(record.id, eventId);
      return res.status(200).json({ ok: true, accion: "evento creado", eventId });
    }

    // --- Pago editado ---
    if (type === "UPDATE") {
      // Evita el bucle: si lo unico que cambio fue el id del evento, no hacemos nada
      const soloCambioElId =
        record.calendar_event_id !== old_record.calendar_event_id &&
        record.nombre === old_record.nombre &&
        Number(record.monto) === Number(old_record.monto) &&
        record.moneda === old_record.moneda &&
        record.dia_cobro === old_record.dia_cobro &&
        record.tipo === old_record.tipo &&
        record.fecha_unica === old_record.fecha_unica &&
        record.categoria === old_record.categoria &&
        record.activo === old_record.activo;
      if (soloCambioElId) {
        return res.status(200).json({ skipped: "solo se guardo el id" });
      }

      // Se desactivo: fuera el evento
      if (!record.activo) {
        if (record.calendar_event_id) {
          await borrarEvento(token, record.calendar_event_id);
          await saveEventId(record.id, null);
        }
        return res.status(200).json({ ok: true, accion: "evento eliminado" });
      }

      // Se reactivo o nunca tuvo evento: se crea
      if (!record.calendar_event_id) {
        const eventId = await crearEvento(token, record);
        await saveEventId(record.id, eventId);
        return res.status(200).json({ ok: true, accion: "evento creado", eventId });
      }

      const cambioDia =
        record.dia_cobro !== old_record.dia_cobro ||
        record.tipo !== old_record.tipo ||
        record.fecha_unica !== old_record.fecha_unica;
      await actualizarEvento(token, record.calendar_event_id, record, cambioDia);
      return res
        .status(200)
        .json({ ok: true, accion: cambioDia ? "fecha y titulo" : "titulo" });
    }

    return res.status(200).json({ skipped: `tipo ${type} sin manejar` });
  } catch (e) {
    await registrarError("pagos", e.message);
    return res.status(200).json({ error: e.message });
  }
}
