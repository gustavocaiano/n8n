// n8n Code node: build the Telegram text for a CONFIRMED intake, never before.
// It runs after the response to Vortex (v2) or after the legacy completion, so it can only
// add a message: any problem returns no items and never affects Vortex or the Plane ticket.
// Sent with parse_mode HTML (the n8n Telegram node would otherwise apply Markdown, where one stray
// "_", "*" or "[" in user text makes Telegram reject the whole message). Every user-written piece
// goes through field(): cleaned, capped, THEN escaped (&, <, >), so it always renders literally.
// Logs, attachment contents and e-mail addresses are never included.
try {
  const request = $('Normalize request').first()?.json ?? {};
  if (request.valid !== true) return [];
  const outcome = $('Validate confirmation').first()?.json ?? {};
  if (outcome.httpStatus !== 200 || outcome.response?.status !== 'completed') return [];
  // Fresh imports keep the CHANGE-ME placeholder: stay silent until a real chat id is set.
  const chatId = String($('Config').first()?.json?.telegramChatId ?? '').trim();
  if (!/^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chatId)) return [];

  const payload = request.payload ?? {};
  const clean = (value, max) => {
    const text = (typeof value === 'string' ? value : '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, ' ')
      .replace(/\n{3,}/g, '\n\n').trim();
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
  };
  const field = (value, max) => clean(value, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const instanceName = field(payload.instance?.name, 100);
  const instanceUrl = field(payload.instance?.url, 200);
  const userName = field(payload.user?.name, 100);
  const username = field(payload.user?.username, 100);
  const version = field(payload.version, 40);
  const description = field(payload.description, 500);

  const who = [userName, username && `(${username})`].filter(Boolean).join(' ');
  const by = [who && `Por: ${who}`, version && `Vortex ${version}`].filter(Boolean).join(' · ');
  const bytes = payload.logs?.bytes;
  const files = [
    request.hasAttachment && '📎 Anexo',
    request.hasLogs && `🧾 Logs 48 h${Number.isInteger(bytes) && bytes > 0 ? `: ${bytes} bytes` : ''}${payload.logs?.truncated ? ' (truncados)' : ''}`,
  ].filter(Boolean).join(' · ');
  // The adapter only exposes the ticket number through logs_ref ("VORTEX-22_<uuid>.txt").
  const ticket = /^([A-Z][A-Z0-9]*-\d+)_/.exec(outcome.response?.logs_ref ?? '')?.[1];

  const lines = [
    `${payload.type === 'bug' ? '🐞 Bug' : '✨ Feature'}${instanceName ? ` de ${instanceName}` : ''}`,
    field(payload.title, 160),
    description && `\n${description}\n`,
    by, instanceUrl && `Instância: ${instanceUrl}`, files, ticket && `Ticket: ${ticket}`,
  ].filter((line) => line !== '' && line !== undefined && line !== false && line !== null);
  return [{ json: { notifyText: lines.join('\n').replace(/\n{3,}/g, '\n\n') } }];
} catch {
  return [];
}
