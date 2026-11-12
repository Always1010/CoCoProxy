/** Coarse display metadata only; never an authentication or device identity signal. */
export function browserLabel(userAgent: string | null): string {
  const ua = userAgent?.slice(0, 2048) ?? '';
  const browser = /Edg(?:A|iOS)?\//.test(ua) ? 'Edge'
    : /(?:OPR|OPT)\//.test(ua) ? 'Opera'
      : /(?:Firefox|FxiOS)\//.test(ua) ? 'Firefox'
        : /(?:Chrome|CriOS|Chromium)\//.test(ua) ? 'Chrome'
          : /Version\/.*Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPad|Macintosh.*Mobile\//.test(ua) ? 'iPadOS'
    : /iPhone|iPod/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
              : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} · ${system}` : browser;
}
