import { motivoDoServidor } from '@hangar/core';
import * as m from '../../paraglide/messages';

function serverError(error: Error): boolean {
  const fields = error as Error & { status?: unknown; envelope?: unknown };
  return typeof fields.status === 'number' || fields.envelope != null || motivoDoServidor(error) !== null
    || /^\d{3}(?::|\s|$)/.test(error.message);
}

export function isNativeCancellation(error: unknown): boolean {
  return error instanceof Error && !serverError(error) && (error.name === 'AbortError'
    || /^fetch failed:.*FetchRequestCanceledException: Fetch request has been canceled\b/i.test(error.message));
}

export function loadErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (serverError(error)) return motivoDoServidor(error) ?? error.message;
  return isNativeCancellation(error) || error.name === 'TimeoutError'
    || /^(?:fetch failed\b|failed to fetch\b|network request failed\b|load failed\b|NetworkError when attempting to fetch resource\b)/i.test(error.message)
    ? m.native_network_error() : error.message;
}
