/** Shared transactional email shell and reusable message blocks. */
import process from "node:process";

const SITE_URL = 'https://trynoelle.com';
export function emailAppUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://app.trynoelle.com').replace(/\/$/, '');
}
const APP_URL = emailAppUrl();
const LOCKUP_ON_INK_URL = `${APP_URL}/brand/noelle-lockup-white.png?v=geometric-1`;

/**
 * @typedef {Object} EmailTemplateOptions
 * @property {string} body                 Main body HTML (use the helpers below).
 * @property {string} [preheader]          Inbox preview text. Hidden in the body.
 * @property {string} [unsubscribeUrl]     If set, renders the unsubscribe link.
 * @property {string} [receivingReason]    Plain-English "why am I getting this?" line.
 * @property {boolean} [transactional]     true => no unsub link, footer says "system mail". Default false.
 */

/** @param {EmailTemplateOptions} options */
export function buildEmailHtml(options) {
  const {
    body,
    preheader,
    unsubscribeUrl,
    receivingReason,
    transactional = false,
  } = options;

  const preheaderBlock = preheader
    ? `<div style="display:none;font-size:1px;color:#f3f5f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : '';

  const unsubscribeBlock =
    !transactional && unsubscribeUrl
      ? `<a href="${unsubscribeUrl}" style="color:#245bd6;text-decoration:underline;font-weight:500;">Unsubscribe</a>
         <span style="color:#d9dee8;margin:0 8px;">&middot;</span>`
      : '';

  const reasonBlock = receivingReason
    ? `<p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#647087;">${escapeHtml(receivingReason)}</p>`
    : '';

  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Noelle</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
  <style>
    @media (max-width: 480px) {
      .n-card-body { padding: 36px 28px !important; }
      .n-h1 { font-size: 30px !important; line-height: 1.1 !important; }
    }
    a.n-btn:hover { background-color: #1748b0 !important; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f3f5f9;font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#162138;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  ${preheaderBlock}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f3f5f9;">
    <tr>
      <td align="center" style="padding:48px 16px;">

        <!-- Main card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #d9dee8;">

          <!-- Header: white lockup on the dark ink band -->
          <tr>
            <td style="background-color:#162138;background-image:linear-gradient(180deg,#162138 0%,#162138 100%);padding:36px 40px;text-align:center;border-bottom:3px solid #245bd6;">
              <img src="${LOCKUP_ON_INK_URL}" alt="Noelle" width="144" height="46" style="display:block;margin:0 auto;width:144px;height:auto;border:0;" />
              <p style="margin:10px 0 0;font-size:12px;color:#647087;letter-spacing:0.04em;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;text-transform:uppercase;">
                Your social growth workspace
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="n-card-body" style="padding:44px 40px 36px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 40px 32px;background-color:#f3f5f9;border-top:1px solid #d9dee8;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <p style="margin:0 0 2px;font-size:14px;font-weight:600;color:#162138;">Noelle team</p>
                    <p style="margin:0 0 14px;font-size:13px;color:#647087;">Social engagement and content planning</p>
                    <a href="${SITE_URL}" style="display:inline-block;text-decoration:none;font-size:12px;color:#35435c;letter-spacing:0.02em;">trynoelle.com &nearr;</a>
                  </td>
                </tr>
              </table>

              <hr style="margin:20px 0;border:none;border-top:1px solid #d9dee8;" />

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="font-size:12px;color:#647087;line-height:1.6;">
                    ${reasonBlock}
                    ${unsubscribeBlock}
                    <a href="${SITE_URL}/privacy" style="color:#647087;text-decoration:underline;">Privacy</a>
                    <span style="color:#d9dee8;margin:0 8px;">&middot;</span>
                    <a href="${SITE_URL}/terms" style="color:#647087;text-decoration:underline;">Terms</a>
                    <span style="color:#d9dee8;margin:0 8px;">&middot;</span>
                    <a href="${APP_URL}" style="color:#647087;text-decoration:underline;">Open dashboard</a>
                  </td>
                </tr>
              </table>

              <p style="margin:14px 0 0;font-size:11px;color:#647087;opacity:0.8;">&copy; ${year} Noelle Labs. </p>
            </td>
          </tr>

        </table>
        <!-- /Main card -->

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Eyebrow label above an h1. Uppercase label. */
export function eyebrow(text) {
  return `<p style="margin:0 0 12px;font-size:11px;line-height:1.4;font-weight:500;letter-spacing:1.5px;text-transform:uppercase;color:#245bd6;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;">${escapeHtml(text)}</p>`;
}

/** Message headline. Use once per email, above lede paragraph. */
export function headline(text) {
  return `<h1 class="n-h1" style="margin:0 0 16px;font-family:'Manrope',-apple-system,sans-serif;font-size:36px;line-height:1.05;letter-spacing:-0.5px;font-weight:400;color:#162138;">${text}</h1>`;
}

/** Body paragraph. Pass raw HTML — caller is responsible for escaping. */
export function paragraph(html) {
  return `<p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#35435c;">${html}</p>`;
}

/** Primary CTA button. Centered. */
export function ctaButton(href, label) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
  <tr>
    <td align="center" style="border-radius:10px;background-color:#245bd6;" bgcolor="#245bd6">
      <a class="n-btn" href="${href}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:'Manrope',-apple-system,sans-serif;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:0.02em;">
        ${escapeHtml(label)}&nbsp;&rarr;
      </a>
    </td>
  </tr>
</table>`;
}

/** Subtle info box with hairline border. */
export function infoBox(contentHtml) {
  return `<div style="margin:24px 0;padding:18px 22px;background-color:#f3f5f9;border-radius:10px;border:1px solid #d9dee8;font-size:14px;line-height:1.55;color:#35435c;">
  ${contentHtml}
</div>`;
}

/** Monospace block — for confirmation codes, raw URLs, etc. */
export function monoBlock(text, { center = false, large = false } = {}) {
  const align = center ? 'text-align:center;' : '';
  const size = large
    ? 'font-size:36px;letter-spacing:10px;font-weight:500;'
    : 'font-size:12px;word-break:break-all;';
  return `<div style="margin:18px 0;padding:${large ? '24px' : '14px 18px'};background-color:#f3f5f9;border:1px solid #d9dee8;border-radius:8px;${align}">
  <p style="margin:0;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;${size}line-height:1.3;color:#162138;">${text}</p>
</div>`;
}

/** Hairline separator. */
export function divider() {
  return `<div style="margin:28px 0;border-top:1px solid #d9dee8;"></div>`;
}

/** Faint footnote inside the body card. */
export function footnote(html) {
  return `<p style="margin:18px 0 0;font-size:13px;line-height:1.55;color:#647087;">${html}</p>`;
}

/** Minimal HTML-escape for user-supplied text in attrs / inline text. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
