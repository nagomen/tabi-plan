import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.js";

let transport: Transporter | undefined;

export function mailConfigured(): boolean {
  return Boolean(config.mail.host && config.mail.user && config.mail.password && config.mail.from);
}

function transporter(): Transporter {
  if (!mailConfigured()) throw new Error("SMTP is not configured");
  transport ||= nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.password },
    requireTLS: !config.mail.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

export async function sendTextMail(input: { to: string; subject: string; text: string }): Promise<string> {
  const result = await transporter().sendMail({
    from: config.mail.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
  return String(result.messageId || "").slice(0, 255);
}
