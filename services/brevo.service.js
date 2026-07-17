// Envío de correos transaccionales por la API HTTP de Brevo.
//
// Se usa la API y no el SMTP relay a propósito: el relay de Brevo enruta por
// región y el nodo de Sudamérica presenta un certificado emitido para
// *.sendinblue.com, que no casa con smtp-relay.brevo.com. Cualquier cliente que
// valide TLS estrictamente rechaza esa conexión. La API va por HTTPS normal y
// no sufre el problema.

const API_URL = 'https://api.brevo.com/v3/smtp/email';

// El remitente debe estar verificado en Brevo. Ojo: si es de un dominio
// gratuito (gmail, yahoo…), Brevo reescribe la dirección a @brevosend.com
// porque esos dominios no se pueden autenticar con DKIM/DMARC. Para que el
// correo salga con la marca propia hace falta un dominio autenticado.
function remitente() {
  return {
    email: process.env.BREVO_REMITENTE_EMAIL,
    name: process.env.BREVO_REMITENTE_NOMBRE || 'CASH R&R',
  };
}

// Devuelve { ok, motivo } en vez de lanzar: los llamadores son flujos que no
// deben romperse porque el correo falle (p. ej. recuperar contraseña responde
// lo mismo pase lo que pase, para no revelar qué correos existen).
async function enviarCorreo({ para, asunto, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, motivo: 'Falta BREVO_API_KEY en el entorno.' };
  if (!process.env.BREVO_REMITENTE_EMAIL) {
    return { ok: false, motivo: 'Falta BREVO_REMITENTE_EMAIL en el entorno.' };
  }

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: remitente(),
        to: [{ email: para }],
        subject: asunto,
        htmlContent: html,
      }),
    });

    if (!resp.ok) {
      // Se deja el cuerpo largo a propósito: los errores de Brevo traen enlaces
      // de ayuda al final y recortarlos corto los vuelve inservibles.
      const cuerpo = await resp.text();
      return { ok: false, motivo: `HTTP ${resp.status}: ${cuerpo.slice(0, 400)}` };
    }

    const data = await resp.json();
    return { ok: true, messageId: data.messageId };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

function plantillaRecuperacion(enlace) {
  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
    <table role="presentation" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 4px;font-size:20px;color:#111827;">CASH R&amp;R</h1>
        <p style="margin:0 0 24px;font-size:13px;color:#6b7280;">Gestión de cartera</p>

        <h2 style="margin:0 0 12px;font-size:17px;color:#111827;">Restablece tu contraseña</h2>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#374151;">
          Recibimos una solicitud para cambiar la contraseña de tu cuenta. Haz clic
          en el botón para elegir una nueva. El enlace vence en una hora.
        </p>

        <a href="${enlace}"
           style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;
                  padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">
          Cambiar mi contraseña
        </a>

        <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">
          Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue funcionando
          y nadie puede cambiarla sin este enlace.
        </p>

        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
        <p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af;">
          ¿El botón no funciona? Copia y pega esta dirección en tu navegador:<br>
          <span style="word-break:break-all;color:#6b7280;">${enlace}</span>
        </p>
      </td></tr>
    </table>
  </body>
</html>`;
}

async function enviarRecuperacion(para, enlace) {
  return enviarCorreo({
    para,
    asunto: 'Restablece tu contraseña — CASH R&R',
    html: plantillaRecuperacion(enlace),
  });
}

module.exports = { enviarCorreo, enviarRecuperacion, plantillaRecuperacion };
