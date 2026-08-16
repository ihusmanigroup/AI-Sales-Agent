import dotenv from 'dotenv';

dotenv.config();

export interface MeetingLinkResult {
  link: string;
  provider: string;
  error?: string;
}

/**
 * Calendar/meeting provider. Creates a real Google Meet link when credentials
 * are configured. When not configured it NEVER fabricates a link — it returns
 * an empty link with a NOT_CONFIGURED provider so the UI can honestly tell the
 * user to connect Google Calendar.
 */
export async function createMeetingLink(opts: {
  subject: string;
  when: Date;
  attendeeEmail?: string;
}): Promise<MeetingLinkResult> {
  const clientEmail = process.env.GOOGLE_CALENDAR_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_CALENDAR_PRIVATE_KEY;

  if (clientEmail && privateKey && process.env.DEMO_MODE !== 'true') {
    try {
      // googleapis is optional and only loaded when credentials exist.
      // @ts-ignore - optional dependency not installed in default setup
      const { google } = await import('googleapis');
      const auth = new google.auth.JWT(clientEmail, undefined, privateKey.replace(/\\n/g, '\n'), [
        'https://www.googleapis.com/auth/calendar'
      ]);
      const calendar = google.calendar({ version: 'v3', auth });
      const event = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: opts.subject,
          start: { dateTime: opts.when.toISOString() },
          end: { dateTime: new Date(opts.when.getTime() + 30 * 60000).toISOString() },
          conferenceData: {
            createRequest: { requestId: `agent-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } }
          }
        },
        conferenceDataVersion: 1
      });
      if (event.data.hangoutLink) {
        return { link: event.data.hangoutLink, provider: 'GOOGLE_CALENDAR' };
      }
      return { link: '', provider: 'GOOGLE_CALENDAR_ERROR', error: 'Google Calendar created the event but returned no meeting link.' };
    } catch (e) {
      console.warn('⚠️ Google Calendar failed:', (e as Error).message);
      return { link: '', provider: 'GOOGLE_CALENDAR_ERROR', error: (e as Error).message };
    }
  }

  return { link: '', provider: 'NOT_CONFIGURED' };
}

export const calendar = {
  createMeeting: createMeetingLink,
  isSimulated: () => !process.env.GOOGLE_CALENDAR_CLIENT_EMAIL || process.env.DEMO_MODE === 'true'
};