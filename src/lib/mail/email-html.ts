/**
 * Prepare an email's HTML for display in the Mail reading pane.
 *
 * Email HTML is untrusted (anyone can send it). The main control is the
 * browser: the reading pane renders it in an <iframe sandbox> WITHOUT
 * `allow-scripts`, so no script in the email can run, and the Content Security
 * Policy below blocks scripts, frames, plugins and form posts a second time.
 * This function adds a third layer by removing active content before the HTML
 * reaches the browser. It is display-only: this HTML is never stored and never
 * sent to a model.
 */

const MAX_HTML_CHARS = 500_000;

/** CSP for the email document: images and inline styles only, nothing active. */
export const EMAIL_CSP = [
  "default-src 'none'",
  "img-src https: http: data:",
  "style-src 'unsafe-inline' https:",
  "font-src https: data:",
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Remove scripts, embedded documents, forms, meta refresh, event handlers and javascript: URLs. */
export function sanitizeEmailHtml(html: string): string {
  return (
    html
      .slice(0, MAX_HTML_CHARS)
      // Whole elements whose content must never render.
      .replace(/<(script|noscript|iframe|frame|frameset|object|embed|applet|template)\b[\s\S]*?<\/\1\s*>/gi, "")
      // Any unclosed or self-closing leftovers of the same, plus tags that change document behaviour.
      .replace(/<\/?(script|noscript|iframe|frame|frameset|object|embed|applet|template|base|meta|link|form)\b[^>]*>/gi, "")
      // Inline event handlers: onclick=, onload=, ... (quoted or bare values).
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // javascript:/vbscript: and data:text/html in links and sources.
      .replace(
        /\s(href|src|action|formaction|xlink:href|background)\s*=\s*("|')?\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2?/gi,
        ' $1="#"',
      )
  );
}

/**
 * Point `cid:` image references at their embedded image data. Runs after
 * sanitising so large images are not cut by the length cap. Only image data:
 * URLs are accepted (the CSP allows data: images; nothing active).
 */
export function embedInlineImages(html: string, inlineImages: Record<string, string> | undefined): string {
  if (!inlineImages) return html;
  const images = new Map(
    Object.entries(inlineImages)
      .filter(([, url]) => /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(url))
      .map(([cid, url]) => [cid.toLowerCase(), url] as const),
  );
  if (images.size === 0) return html;
  return html.replace(/(["'(\s=])cid:([^"'()\s>]+)/gi, (whole, lead: string, cid: string) => {
    const url = images.get(cid.toLowerCase()) ?? images.get(safeDecode(cid).toLowerCase());
    return url ? `${lead}${url}` : whole;
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Wrap sanitised email HTML in a standalone document for an iframe srcdoc.
 *
 * `breakAnywhere` (default on, for received mail) lets long unbroken strings
 * such as URLs wrap. Turn it off to lay a block out the way Gmail does: it
 * also lets table cells shrink to one character, so report table headers
 * ("Split", "Clicks") would wrap mid-word.
 */
export function buildEmailDocument(
  html: string,
  { breakAnywhere = true, inlineImages }: { breakAnywhere?: boolean; inlineImages?: Record<string, string> } = {},
): string {
  const body = embedInlineImages(sanitizeEmailHtml(html), inlineImages);
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    "<style>",
    "html,body{margin:0;padding:0;background:#fff;color:#202124;}",
    `body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;${breakAnywhere ? "overflow-wrap:anywhere;" : ""}padding:4px 2px;}`,
    "img{max-width:100%;height:auto;}",
    "table{max-width:100%;}",
    "a{color:#1a73e8;}",
    "</style>",
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}
