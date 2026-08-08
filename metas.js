// Pieza que corre en el servidor de Vercel, no en el navegador.
// Consulta las respuestas del formulario "Cierre diario" en KoboToolbox, suma
// las participaciones y devuelve solo cifras agregadas. El token vive en una
// variable de entorno del proyecto y nunca sale de acá.
const SERVIDOR = process.env.KOBO_SERVIDOR || 'https://kf.kobotoolbox.org';
const FORM = process.env.KOBO_FORM || 'asSki5mNoZuam6h2YQn5fR';
const TOKEN = process.env.KOBO_TOKEN;

const ROLES = {
  tallerista_comunicacion: 'COM',
  tallerista_liderazgo: 'LID',
  tallerista_arte: 'ART',
  psicologo: 'PSI',
};

// lunes de la semana 1 del plan; sirve para ubicar cada envío en su semana
const INICIO = new Date('2026-08-10T00:00:00-05:00');

async function traer() {
  const filas = [];
  let url = SERVIDOR + '/api/v2/assets/' + FORM + '/data/?format=json&limit=1000';
  // Kobo pagina de mil en mil; se sigue el enlace "next" hasta que se acaba
  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'Token ' + TOKEN } });
    if (!r.ok) throw new Error('Kobo respondió ' + r.status + ' ' + r.statusText);
    const j = await r.json();
    filas.push(...(j.results || []));
    url = j.next || null;
  }
  return filas;
}

module.exports = async (req, res) => {
  // el navegador puede guardar el resultado dos minutos; así no se consulta
  // Kobo en cada recarga ni se choca con sus límites de uso
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  if (!TOKEN) {
    return res.status(500).json({ error: 'Falta la variable de entorno KOBO_TOKEN' });
  }
  try {
    const filas = await traer();

    // La meta del 60% es sobre estudiantes, así que solo cuentan los registros
    // de talleristas con público objetivo alumnos. Docentes y padres se llevan
    // aparte para que no inflen el indicador.
    const porColegio = {}, porComponente = { COM: 0, LID: 0, ART: 0 }, porSemana = {};
    const publico = { alumnos: 0, docentes: 0, padres: 0 };
    const psi = { registros: 0, participaciones: 0, talleresCerrados: 0,
      porTipo: { taller: 0, charla: 0, capacitacion: 0 },
      porPublico: { alumnos: 0, docentes: 0, padres: 0 }, porColegio: {} };
    let sinColegio = 0, sinNumero = 0;

    for (const f of filas) {
      const cod = f.colegio;                       // viene como ie_001 ... ie_175
      const n = Number(f.num_alumnos);
      const g = ROLES[f.rol] || null;
      // si el registro es viejo y no trae público, se asume alumnos
      const pub = f.publico_objetivo || 'alumnos';
      const tipo = f.tipo_actividad || '';
      const ses = Number(f.numero_sesion);

      if (!cod) { sinColegio++; continue; }
      if (!Number.isFinite(n) || n <= 0) { sinNumero++; continue; }
      const ie = parseInt(String(cod).replace(/\D/g, ''), 10);
      if (publico[pub] !== undefined) publico[pub] += n;

      const t = new Date(f._submission_time);
      const sem = Math.floor((t - INICIO) / (7 * 24 * 3600 * 1000)) + 1;

      if (g === 'PSI') {
        psi.registros++;
        psi.participaciones += n;
        psi.porColegio[ie] = (psi.porColegio[ie] || 0) + n;
        if (psi.porTipo[tipo] !== undefined) psi.porTipo[tipo] += 1;
        if (psi.porPublico[pub] !== undefined) psi.porPublico[pub] += n;
        // cada cuatro sesiones se cierra un taller
        if (tipo === 'taller' && ses === 4) psi.talleresCerrados++;
        continue;
      }

      if (!g || pub !== 'alumnos') continue;        // la meta cuenta solo alumnos
      porColegio[ie] = (porColegio[ie] || 0) + n;
      porComponente[g] += n;
      if (sem >= 1 && sem <= 20) {
        porSemana[sem] = porSemana[sem] || { COM: 0, LID: 0, ART: 0 };
        porSemana[sem][g] += n;
      }
    }

    res.status(200).json({
      generado: new Date().toISOString(),
      envios: filas.length,
      total: Object.values(porColegio).reduce((s, x) => s + x, 0),
      porComponente,
      porColegio,
      porSemana,
      publico,
      psicologia: psi,
      descartados: { sinColegio, sinNumero },
    });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo consultar KoboToolbox', detalle: String(e.message || e) });
  }
};
