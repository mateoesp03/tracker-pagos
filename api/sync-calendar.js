// api/sync-calendar.js
// Recibe el webhook de Supabase cuando marcas/desmarcas un pago
// y actualiza el evento correspondiente en Google Calendar.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

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

async function getPayment(paymentId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/fixed_payments?id=eq.${paymentId}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(`Supabase: ${JSON.stringify(rows)}`);
  return rows[0] || null;
}

// Devuelve { id, debug } para poder diagnosticar si algo falla
async function findInstance(token, eventId, mes) {
  const [year, month] = mes.split("-").map(Number);
  const timeMin = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const timeMax = new Date(Date.UTC(year, month, 1)).toISOString();

  const url =
    `${CAL_API}/${encodeURIComponent(eventId)}/instances` +
    `?timeMin=${encodeURIComponent(timeMin)}` +
    `&timeMax=${encodeURIComponent(timeMax)}` +
    `&maxResults=5`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const raw = await res.text();

  if (res.ok) {
    const data = JSON.parse(raw);
    if (data.items && data.items.length) {
      return { id: data.items[0].id, debug: null };
    }
    // Evento único: la recurrencia no aplica, revisamos el evento directo
    const single = await fetch(`${CAL_API}/${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sraw = await single.text();
    if (!single.ok) return { id: null, debug: `single ${single.status}: ${sraw}` };
    const ev = JSON.parse(sraw);
    const starts = ev.start?.dateTime || ev.start?.date || "";
    return {
      id: starts.startsWith(mes) ? ev.id : null,
      debug: starts.startsWith(mes) ? null : `evento unico fuera del mes (${starts})`,
    };
  }

  return { id: null, debug: `instances ${res.status}: ${raw.slice(0, 300)}` };
}

function formatMonto(monto, moneda) {
  const n = Number(monto);
  return moneda === "USD" ? `US$${n}` : `S/${n}`;
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

export default async function handler(req, res) {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }

  try {
    const { type, record, old_record } = req.body;
    const row = record || old_record;
    if (!row?.payment_id || !row?.mes) {
      return res.status(200).json({ skipped: "payload sin payment_id o mes" });
    }

    const pago = await getPayment(row.payment_id);
    if (!pago?.calendar_event_id) {
      return res.status(200).json({ skipped: "pago sin evento vinculado" });
    }

    const token = await getAccessToken();

    // Un pago de una sola vez no tiene repeticiones: el evento es uno solo
    let instanceId, debug;
    if (pago.tipo === "unico") {
      instanceId = pago.calendar_event_id;
    } else {
      ({ id: instanceId, debug } = await findInstance(
        token,
        pago.calendar_event_id,
        row.mes
      ));
    }

    if (!instanceId) {
      return res.status(200).json({
        skipped: "no se encontro instancia",
        pago: pago.nombre,
        eventId: pago.calendar_event_id,
        mes: row.mes,
        debug,
      });
    }

    const monto = formatMonto(pago.monto, pago.moneda);
    const pagado = type === "INSERT";

    const body = pagado
      ? {
          summary: `✅ ${pago.nombre} pagado - ${monto}`,
          reminders: { useDefault: false, overrides: [] },
        }
      : {
          summary: `Pagar ${pago.nombre} - ${monto}`,
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 4320 },
              { method: "popup", minutes: 0 },
            ],
          },
        };

    const patch = await fetch(`${CAL_API}/${encodeURIComponent(instanceId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const praw = await patch.text();
    if (!patch.ok) {
      await registrarError("marcado de pago", `${patch.status}: ${praw.slice(0, 300)}`);
      return res
        .status(200)
        .json({ error: "patch fallo", status: patch.status, detalle: praw.slice(0, 300) });
    }

    return res.status(200).json({ ok: true, pago: pago.nombre, pagado });
  } catch (e) {
    await registrarError("marcado de pago", e.message);
    return res.status(200).json({ error: e.message });
  }
}
