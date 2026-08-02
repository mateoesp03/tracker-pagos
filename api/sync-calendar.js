// api/sync-calendar.js
// Recibe el webhook de Supabase cuando marcas/desmarcas un pago
// y actualiza el evento correspondiente en Google Calendar.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// Pide un access token temporal usando el refresh token
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

// Trae el pago desde Supabase
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

// Busca la instancia del evento que cae dentro del mes indicado ("2026-07").
// Si el evento no es recurrente, devuelve el evento mismo.
async function findInstance(token, eventId, mes) {
  const [year, month] = mes.split("-").map(Number);
  const timeMin = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const timeMax = new Date(Date.UTC(year, month, 1)).toISOString();

  const url = `${CAL_API}/${eventId}/instances?timeMin=${timeMin}&timeMax=${timeMax}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.ok) {
    const data = await res.json();
    if (data.items && data.items.length) return data.items[0].id;
  }

  // Evento único (no recurrente): la API de instances falla, usamos el evento directo
  const single = await fetch(`${CAL_API}/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!single.ok) return null;
  const ev = await single.json();
  return ev.start?.dateTime?.startsWith(mes) ? ev.id : null;
}

// Formatea "S/ 120" o "US$ 21"
function formatMonto(monto, moneda) {
  const n = Number(monto);
  return moneda === "USD" ? `US$${n}` : `S/${n}`;
}

export default async function handler(req, res) {
  // Solo aceptamos llamadas con el secreto correcto
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
    const instanceId = await findInstance(token, pago.calendar_event_id, row.mes);
    if (!instanceId) {
      return res.status(200).json({ skipped: "no se encontro instancia del mes" });
    }

    const monto = formatMonto(pago.monto, pago.moneda);
    const pagado = type === "INSERT";

    // Si esta pagado: titulo con check y sin recordatorios.
    // Si se desmarca: vuelve el titulo normal y los avisos (3 dias antes + mismo dia).
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

    const patch = await fetch(`${CAL_API}/${instanceId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!patch.ok) {
      const err = await patch.json();
      throw new Error(`Calendar PATCH: ${JSON.stringify(err)}`);
    }

    return res.status(200).json({ ok: true, pago: pago.nombre, pagado });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
