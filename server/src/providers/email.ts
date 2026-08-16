import dotenv from 'dotenv';

dotenv.config();

export interface SendResult {
  status: 'sent' | 'simulated' | 'failed' | 'blocked';
  providerStatus: string;
  error?: string;
}

interface SendOpts {
  to: string;
  subject: string;
  body: string;
  from?: string;
}

function parseSender(sender: string): { name?: string; email: string } {
  const m = sender.match(/^\s*([^<]*?)\s*<([^>]+)>/);
  if (m && m[2]) return { name: m[1]?.trim() || undefined, email: m[2].trim() };
  return { email: sender.trim() };
}

async function sendViaSendGrid(opts: SendOpts, apiKey: string, from: string): Promise<SendResult> {
  const { name, email: fromEmail } = parseSender(from);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: fromEmail, name: name || undefined },
        subject: opts.subject,
        content: [{ type: 'text/plain', value: opts.body }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      return { status: 'sent', providerStatus: 'SENDGRID:ACCEPTED' };
    }
    const data: any = await res.json().catch(() => ({}));
    const msg = data?.errors?.map((e: any) => e.message).join('; ') || `SendGrid returned HTTP ${res.status}`;
    return { status: 'failed', providerStatus: `SENDGRID_ERROR:${res.status}`, error: msg };
  } catch (e) {
    return { status: 'failed', providerStatus: 'SENDGRID_ERROR', error: (e as Error).message };
  }
}

async function sendViaResend(opts: SendOpts, apiKey: string, from: string): Promise<SendResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ from, to: opts.to, subject: opts.subject, text: opts.body }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data: any = await res.json();
      return { status: 'sent', providerStatus: data?.id ? `RESEND:${data.id}` : 'SENT' };
    }
    const data: any = await res.json().catch(() => ({}));
    return { status: 'failed', providerStatus: `RESEND_ERROR:${res.status}`, error: data?.message || `Resend returned HTTP ${res.status}` };
  } catch (e) {
    return { status: 'failed', providerStatus: 'RESEND_ERROR', error: (e as Error).message };
  }
}

/**
 * Outbound email provider.
 * - If OUTBOUND_ENABLED is false -> blocked (kill switch).
 * - If DEMO_MODE or neither SENDGRID_API_KEY nor RESEND_API_KEY -> simulated delivery record.
 * - Otherwise sends via SendGrid (preferred) or Resend.
 */
export async function sendEmail(opts: SendOpts): Promise<SendResult> {
  if (process.env.OUTBOUND_ENABLED === 'false') {
    return { status: 'blocked', providerStatus: 'OUTBOUND_DISABLED', error: 'Outbound kill switch is enabled.' };
  }

  const sendgridKey = process.env.SENDGRID_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if ((!sendgridKey && !resendKey) || process.env.DEMO_MODE === 'true') {
    return { status: 'simulated', providerStatus: 'SIMULATED' };
  }

  const from = opts.from || process.env.EMAIL_SENDER || 'AgentHack Sales <sales@agenthack.ai>';
  if (sendgridKey) {
    return sendViaSendGrid(opts, sendgridKey, from);
  }
  return sendViaResend(opts, resendKey!, from);
}

export const email = {
  send: sendEmail,
  isSimulated: () => (!process.env.SENDGRID_API_KEY && !process.env.RESEND_API_KEY) || process.env.DEMO_MODE === 'true'
};
