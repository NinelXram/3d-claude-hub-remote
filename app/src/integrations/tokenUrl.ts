// The server token in a page link. Links put it after # (`#token=…`), which browsers never send to a server, so it
// stays out of tunnel and proxy logs; `?token=…` from older links still works. Pure, so Node tests can check it.

/** The token in `href` (the fragment wins), and the URL's path + query + fragment with every token removed. */
export function takeTokenFromUrl(href: string): { token: string | null; cleaned: string } {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const fromHash = hash.get("token");
  const fromQuery = url.searchParams.get("token");
  url.searchParams.delete("token");
  hash.delete("token");
  const rest = hash.toString();
  // A fragment that was not key=value (e.g. #section) has no token and is kept exactly as written.
  const fragment = fromHash === null ? url.hash : rest ? `#${rest}` : "";
  return { token: fromHash || fromQuery || null, cleaned: url.pathname + url.search + fragment };
}
