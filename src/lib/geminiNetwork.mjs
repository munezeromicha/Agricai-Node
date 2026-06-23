import { Agent, setGlobalDispatcher } from "undici";

/**
 * Node's built-in fetch (undici) may prefer IPv6 and hit connect timeouts on some
 * Windows networks. Force IPv4 + longer timeouts for Gemini API calls.
 */
export function configureGeminiNetwork() {
  const connectTimeout = Number(process.env.GEMINI_CONNECT_TIMEOUT_MS) || 60_000;
  const headersTimeout = Number(process.env.GEMINI_HEADERS_TIMEOUT_MS) || 120_000;

  setGlobalDispatcher(
    new Agent({
      connect: {
        timeout: connectTimeout,
        family: 4,
      },
      headersTimeout,
      bodyTimeout: headersTimeout,
    }),
  );
}

export function isNetworkFetchError(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  const cause = err.cause;
  const causeCode = cause?.code ?? "";
  return (
    /fetch failed/i.test(msg) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNRESET/i.test(msg) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNRESET/i.test(causeCode)
  );
}
