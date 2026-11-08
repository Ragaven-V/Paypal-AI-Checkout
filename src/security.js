/**
 * Security headers. No inline scripts are used anywhere, so scripts are limited to this
 * origin plus PayPal's checkout SDK domains.
 */
const PAYPAL = ['https://*.paypal.com', 'https://*.paypalobjects.com'];

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${PAYPAL.join(' ')}`,
  // 'unsafe-inline' styles: the PayPal SDK injects inline styles for its buttons
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: ${PAYPAL.join(' ')}`,
  `connect-src 'self' ${PAYPAL.join(' ')}`,
  `frame-src ${PAYPAL.join(' ')} https://*.venmo.com`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
  // PayPal checkout opens a popup that talks back to this window, so popups must keep their opener
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // API responses carry carts, orders and chats: never cache them
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
