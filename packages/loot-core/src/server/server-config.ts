import { errorFileFor } from '@actual-app/error-file';

import * as fs from '#platform/server/fs';

type ServerConfig = {
  BASE_SERVER: string;
  SYNC_SERVER: string;
  SIGNUP_SERVER: string;
  GOCARDLESS_SERVER: string;
  SIMPLEFIN_SERVER: string;
  PLUGGYAI_SERVER: string;
  AKAHU_SERVER: string;
  ENABLEBANKING_SERVER: string;
};

const errors = errorFileFor('loot-core/src/server/server-config.ts');

let config: ServerConfig | null = null;

function joinURL(base: string | URL, ...paths: string[]): string {
  const url = new URL(base);
  url.pathname = fs.join(url.pathname, ...paths);
  return url.toString();
}

export function isValidBaseURL(base: string): boolean {
  try {
    return Boolean(new URL(base));
  } catch (e) {
    errors.expected('probing whether a server URL is valid', e);
    return false;
  }
}

export function setServer(url: string): void {
  if (url == null) {
    config = null;
  } else {
    config = getServer(url);
  }
}

// `url` is optional; if not given it will provide the global config
export function getServer(url?: string): ServerConfig | null {
  if (url) {
    try {
      return {
        BASE_SERVER: url,
        SYNC_SERVER: joinURL(url, '/sync'),
        SIGNUP_SERVER: joinURL(url, '/account'),
        GOCARDLESS_SERVER: joinURL(url, '/gocardless'),
        SIMPLEFIN_SERVER: joinURL(url, '/simplefin'),
        PLUGGYAI_SERVER: joinURL(url, '/pluggyai'),
        AKAHU_SERVER: joinURL(url, '/akahu'),
        ENABLEBANKING_SERVER: joinURL(url, '/enablebanking'),
      };
    } catch (error) {
      errors.warn('parsing the server URL', error);
      return config;
    }
  }
  return config;
}
