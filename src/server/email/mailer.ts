import nodemailer from "nodemailer";

type SendResult = { ok: true } | { ok: false; error: unknown };

export async function sendPasswordResetEmail(to: string, link: string): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  // Fallback seguro para pruebas si no se define MAIL_FROM
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || "Vytronix <contacto@vytronix.cl>";

  if (!apiKey) {
    // Dev fallback: log the link instead of sending
    console.log(`[DEV] Email a ${to} â€” ${link}`);
    return { ok: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: "Restablecer tu contraseÃ±a",
        html: emailHtml(link),
        text: `Usa este enlace para restablecer tu contraseÃ±a: ${link}`,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Resend error ${res.status}: ${txt}`);
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[MAIL] Resend OK -> to=${to}, from=${from}`);
      console.log(`[MAIL] Reset link -> ${link}`);
    }
    return { ok: true };
  } catch (error) {
    console.error('[MAIL] Resend send failed:', error);
    return { ok: false, error };
  }
}

function emailHtml(link: string) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111">
    <h2>Restablecer contraseÃ±a</h2>
    <p>Has solicitado restablecer tu contraseÃ±a. Haz clic en el siguiente enlace:</p>
    <p><a href="${link}">${link}</a></p>
    <p style="color:#555;font-size:12px">El enlace expira en 1 hora. Si no fuiste tÃº, ignora este mensaje.</p>
  </div>`;
}

export async function sendContactNotificationEmail(input: {
  name: string;
  email: string;
  phone: string;
  message: string;
}): Promise<SendResult> {
  const to = process.env.CONTACT_NOTIFICATION_TO || process.env.ADMIN_EMAIL;
  if (!to) {
    console.warn("[MAIL] Contact notification skipped: CONTACT_NOTIFICATION_TO/ADMIN_EMAIL not set");
    return { ok: true };
  }

  const subject = `Nuevo lead AI - ${input.name}`;
  const text = `Nuevo lead desde chat asistido de Vytronix:\n\nNombre: ${input.name}\nEmail: ${input.email}\nTelefono: ${input.phone}\n\nDetalle:\n${input.message}`;
  const html = contactHtml(input);

  return sendSmtpEmail({
    to,
    subject,
    text,
    html,
    context: "Contact notification",
    fallbackLog: () => {
      console.log(`[DEV] Contact lead -> ${input.name} (${input.email})`);
      console.log(input.message);
    },
  });
}

function contactHtml({ name, email, phone, message }: { name: string; email: string; phone: string; message: string }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111">
    <h2 style="margin:0 0 12px">Nuevo lead desde chat asistido</h2>
    <p style="margin:0 0 6px"><strong>Nombre:</strong> ${name}</p>
    <p style="margin:0 0 6px"><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
    <p style="margin:0 0 14px"><strong>WhatsApp:</strong> <a href="tel:${phone}">${phone}</a></p>
    <div style="padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb">
      <p style="margin:0 0 8px"><strong>Resumen comercial</strong></p>
      <div style="color:#374151">${message.replace(/\n/g, '<br/>')}</div>
    </div>
    <p style="margin-top:14px;color:#4b5563">Accion sugerida: contactar al lead en menos de 15 minutos.</p>
  </div>`;
}

export async function sendPaymentNotificationEmail(input: {
  userEmail: string;
  amount: number;
  currency: string;
  paymentId: string;
  status: string;
}): Promise<SendResult> {
  const to = process.env.PAYMENT_NOTIFICATION_TO || process.env.ADMIN_EMAIL;
  if (!to) {
    console.warn("[MAIL] Payment notification skipped: PAYMENT_NOTIFICATION_TO/ADMIN_EMAIL not set");
    return { ok: true };
  }

  const subject = `Pago aprobado (${input.paymentId})`;
  const text = `Se registrÃ³ un pago aprobado en Vytronix:\n\nID Pago: ${input.paymentId}\nEstado: ${input.status}\nMonto: ${input.amount} ${input.currency}\nEmail usuario: ${input.userEmail}`;
  const html = paymentHtml(input);

  return sendSmtpEmail({
    to,
    subject,
    text,
    html,
    context: "Payment notification",
  });
}

export async function sendClientProposalEmail(input: {
  toEmail: string;
  service: string;
  estimatedPrice: string;
  totalEstimate?: string;
  summary: string;
  nextSteps: string[];
}): Promise<SendResult> {
  const to = input.toEmail.trim();
  if (!to) {
    return { ok: true };
  }

  const subject = `Propuesta inicial Vytronix | ${input.service}`;
  const text = [
    `Hola,`,
    ``,
    `Gracias por tu interes en Vytronix.`,
    ``,
    `Servicio recomendado: ${input.service}`,
    `Total estimado recomendado: ${input.totalEstimate ?? "Por confirmar"}`,
    `Rango referencial: ${input.estimatedPrice}`,
    ``,
    `Resumen ejecutivo:`,
    input.summary,
    ``,
    `Siguientes pasos:`,
    ...input.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    ``,
    `Si te hace sentido, responde este correo con: "Aprobado" y coordinamos kickoff hoy.`,
  ].join("\n");

  const html = proposalHtml(input);
  return sendSmtpEmail({
    to,
    subject,
    text,
    html,
    context: "Client proposal email",
  });
}

function proposalHtml(input: {
  toEmail: string;
  service: string;
  estimatedPrice: string;
  totalEstimate?: string;
  summary: string;
  nextSteps: string[];
}) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111;max-width:680px">
    <h2 style="margin:0 0 8px">Propuesta inicial Vytronix</h2>
    <p style="margin:0 0 14px;color:#374151">Gracias por tu interes. Te compartimos un resumen claro para avanzar.</p>

    <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:0 0 12px;background:#f8fafc">
      <p style="margin:0 0 8px"><strong>Servicio recomendado:</strong> ${input.service}</p>
      <p style="margin:0 0 8px"><strong>Total estimado recomendado:</strong> ${input.totalEstimate ?? "Por confirmar"}</p>
      <p style="margin:0"><strong>Rango referencial:</strong> ${input.estimatedPrice}</p>
    </div>

    <div style="margin:0 0 12px">
      <p style="margin:0 0 6px"><strong>Resumen ejecutivo</strong></p>
      <p style="margin:0;color:#374151">${input.summary.replace(/\n/g, "<br/>")}</p>
    </div>

    <div style="margin:0 0 12px">
      <p style="margin:0 0 6px"><strong>Siguientes pasos</strong></p>
      <ol style="margin:0 0 0 18px;padding:0">
        ${input.nextSteps.map((step) => `<li style="margin:4px 0">${step}</li>`).join("")}
      </ol>
    </div>

    <p style="margin:12px 0 0">Si estas de acuerdo, responde este correo con <strong>"Aprobado"</strong> y coordinamos kickoff hoy.</p>
  </div>`;
}

function paymentHtml({ userEmail, amount, currency, paymentId, status }: { userEmail: string; amount: number; currency: string; paymentId: string; status: string }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111">
    <h2>Pago aprobado</h2>
    <p><strong>ID pago:</strong> ${paymentId}</p>
    <p><strong>Estado:</strong> ${status}</p>
    <p><strong>Monto:</strong> ${amount} ${currency}</p>
    <p><strong>Email usuario:</strong> <a href="mailto:${userEmail}">${userEmail}</a></p>
  </div>`;
}

async function sendSmtpEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
  context: string;
  fallbackLog?: () => void;
}): Promise<SendResult> {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  const secure = process.env.SMTP_SECURE === "true";
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || (user ? `Vytronix <${user}>` : "Vytronix <contacto@vytronix.cl>");

  if (!host || !user || !pass) {
    console.warn(`[MAIL] ${params.context} skipped: SMTP credentials missing`);
    if (params.fallbackLog) params.fallbackLog();
    return { ok: true };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: port ?? (secure ? 465 : 587),
      secure,
      auth: { user, pass },
    });

    const recipients = params.to.split(",").map((recipient) => recipient.trim()).filter(Boolean);
    await transporter.sendMail({ from, to: recipients, subject: params.subject, text: params.text, html: params.html });
    if (process.env.NODE_ENV !== "production") {
      console.log(`[MAIL] ${params.context} sent -> ${recipients.join(",")}`);
    }
    return { ok: true };
  } catch (error) {
    console.error(`[MAIL] ${params.context} failed:`, error);
    return { ok: false, error };
  }
}









