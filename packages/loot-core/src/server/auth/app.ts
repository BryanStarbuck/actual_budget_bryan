import { errorFileFor } from '@actual-app/error-file';

import * as asyncStorage from '#platform/server/asyncStorage';
import { createApp } from '#server/app';
import * as encryption from '#server/encryption';
import { PostError } from '#server/errors';
import { get, post } from '#server/post';
import { getServer, isValidBaseURL } from '#server/server-config';
import type { OpenIdConfig } from '#types/models';

const errors = errorFileFor('loot-core/src/server/auth/app.ts');

// A PostError carrying one of these reasons means the server could not be reached or did not
// answer sensibly: a fault. Any other reason (bad password, already bootstrapped, unauthorized) is
// the server's answer to the request, not a fault (R7).
const POST_FAULT_REASONS = new Set([
  'network-failure',
  'parse-json',
  'internal',
  'unknown',
]);

function isServerAnswer(err: unknown): boolean {
  return err instanceof PostError && !POST_FAULT_REASONS.has(err.reason);
}

export type AuthHandlers = {
  'get-did-bootstrap': typeof didBootstrap;
  'subscribe-needs-bootstrap': typeof needsBootstrap;
  'subscribe-bootstrap': typeof bootstrap;
  'subscribe-get-login-methods': typeof getLoginMethods;
  'subscribe-get-user': typeof getUser;
  'subscribe-change-password': typeof changePassword;
  'subscribe-sign-in': typeof signIn;
  'subscribe-sign-out': typeof signOut;
  'subscribe-set-token': typeof setToken;
  'enable-openid': typeof enableOpenId;
  'get-openid-config': typeof getOpenIdConfig;
  'enable-password': typeof enablePassword;
};

export const app = createApp<AuthHandlers>();
app.method('get-did-bootstrap', didBootstrap);
app.method('subscribe-needs-bootstrap', needsBootstrap);
app.method('subscribe-bootstrap', bootstrap);
app.method('subscribe-get-login-methods', getLoginMethods);
app.method('subscribe-get-user', getUser);
app.method('subscribe-change-password', changePassword);
app.method('subscribe-sign-in', signIn);
app.method('subscribe-sign-out', signOut);
app.method('subscribe-set-token', setToken);
app.method('enable-openid', enableOpenId);
app.method('get-openid-config', getOpenIdConfig);
app.method('enable-password', enablePassword);

async function didBootstrap() {
  return Boolean(await asyncStorage.getItem('did-bootstrap'));
}

async function needsBootstrap({ url }: { url?: string } = {}) {
  if (url && !isValidBaseURL(url)) {
    return { error: 'get-server-failure' };
  }

  let serverConfig: ReturnType<typeof getServer>;

  try {
    serverConfig = getServer(url);
    if (!serverConfig) {
      return { bootstrapped: true, hasServer: false };
    }
  } catch (e) {
    errors.caught('resolving the server config', e);
    return { error: 'get-server-failure' };
  }

  let resText: string;
  try {
    resText = await get(serverConfig.SIGNUP_SERVER + '/needs-bootstrap');
  } catch (e) {
    if (isServerAnswer(e)) {
      errors.expected('asking the server whether it needs bootstrap', e);
    } else {
      errors.caught('asking the server whether it needs bootstrap', e);
    }
    return { error: 'network-failure' };
  }

  let res: {
    status: 'ok';
    data: {
      bootstrapped: boolean;
      loginMethod: 'password' | 'openid' | string;
      availableLoginMethods: Array<{
        method: string;
        displayName: string;
        active: boolean;
      }>;
      multiuser: boolean;
    };
  };

  try {
    res = JSON.parse(resText);
  } catch (e) {
    errors.caught('parsing the needs-bootstrap response', e);
    return { error: 'parse-failure' };
  }

  return {
    bootstrapped: res.data.bootstrapped,
    availableLoginMethods: res.data.availableLoginMethods || [
      { method: 'password', active: true, displayName: 'Password' },
    ],
    multiuser: res.data.multiuser || false,
    hasServer: true,
  };
}

async function bootstrap(loginConfig: {
  password?: string;
  openId?: OpenIdConfig;
}) {
  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    await post(serverConfig.SIGNUP_SERVER + '/bootstrap', loginConfig);
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('bootstrapping the server', err);
      } else {
        errors.caught('bootstrapping the server', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
  return {};
}

async function getLoginMethods() {
  let res: {
    methods?: Array<{ method: string; displayName: string; active: boolean }>;
  };
  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    res = await fetch(serverConfig.SIGNUP_SERVER + '/login-methods').then(res =>
      res.json(),
    );
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('fetching the login methods', err);
      } else {
        errors.caught('fetching the login methods', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  if (res.methods) {
    return { methods: res.methods };
  }
  return { error: 'internal' };
}

async function getUser() {
  const serverConfig = getServer();
  if (!serverConfig) {
    if (!(await asyncStorage.getItem('did-bootstrap'))) {
      return null;
    }
    return { offline: false };
  }

  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return null;
  }

  try {
    const res = await get(serverConfig.SIGNUP_SERVER + '/validate', {
      headers: {
        'X-ACTUAL-TOKEN': userToken,
      },
    });
    let tokenExpired = false;
    const {
      status,
      reason,
      data: {
        userName = null,
        permission = '',
        userId = null,
        displayName = null,
        loginMethod = null,
        prefs: serverPrefs,
      } = {},
    } = JSON.parse(res) || {};

    if (status === 'error') {
      if (reason === 'unauthorized') {
        return null;
      } else if (reason === 'token-expired') {
        tokenExpired = true;
      } else {
        return { offline: true };
      }
    }

    return {
      offline: false,
      userName,
      permission,
      userId,
      displayName,
      loginMethod,
      tokenExpired,
      serverPrefs,
    };
  } catch (e) {
    if (isServerAnswer(e)) {
      errors.expected('validating the user token', e);
    } else {
      errors.caught('validating the user token', e);
    }
    return { offline: true };
  }
}

async function changePassword({ password }: { password: string }) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return { error: 'not-logged-in' };
  }

  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    await post(serverConfig.SIGNUP_SERVER + '/change-password', {
      token: userToken,
      password,
    });
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('changing the password', err);
      } else {
        errors.caught('changing the password', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  return {};
}

async function signIn(
  loginInfo:
    | {
        password: string;
        loginMethod?: string;
      }
    | {
        returnUrl: string;
        loginMethod?: 'openid';
      },
) {
  if (
    typeof loginInfo.loginMethod !== 'string' ||
    loginInfo.loginMethod == null
  ) {
    loginInfo.loginMethod = 'password';
  }
  let res: {
    token?: string;
    returnUrl?: string;
  };

  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    res = await post(serverConfig.SIGNUP_SERVER + '/login', loginInfo);
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('signing in', err);
      } else {
        errors.caught('signing in', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  if (res.returnUrl) {
    return { redirectUrl: res.returnUrl };
  }

  if (!res.token) {
    throw new Error('login: User token not set');
  }

  await asyncStorage.setItem('user-token', res.token);
  return {};
}

async function signOut() {
  encryption.unloadAllKeys();
  await asyncStorage.multiRemove([
    'user-token',
    'encrypt-keys',
    'lastBudget',
    'readOnly',
  ]);
  return 'ok';
}

async function setToken({ token }: { token: string }) {
  await asyncStorage.setItem('user-token', token);
}

async function enableOpenId(openIdConfig: { openId: OpenIdConfig }) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    if (!userToken) {
      return { error: 'unauthorized' };
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    await post(serverConfig.BASE_SERVER + '/openid/enable', openIdConfig, {
      'X-ACTUAL-TOKEN': userToken,
    });
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('enabling OpenID on the server', err);
      } else {
        errors.caught('enabling OpenID on the server', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
  return {};
}

async function getOpenIdConfig({ password }: { password: string }) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    const res = await post(
      serverConfig.BASE_SERVER + '/openid/config',
      { password },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );

    if (res) {
      return res as { openId: OpenIdConfig };
    }

    return null;
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('fetching the OpenID config', err);
      } else {
        errors.caught('fetching the OpenID config', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
}

async function enablePassword(passwordConfig: { password: string }) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    if (!userToken) {
      return { error: 'unauthorized' };
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    await post(serverConfig.BASE_SERVER + '/openid/disable', passwordConfig, {
      'X-ACTUAL-TOKEN': userToken,
    });
  } catch (err) {
    if (err instanceof PostError) {
      if (isServerAnswer(err)) {
        errors.expected('enabling password login on the server', err);
      } else {
        errors.caught('enabling password login on the server', err);
      }
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
  return {};
}
