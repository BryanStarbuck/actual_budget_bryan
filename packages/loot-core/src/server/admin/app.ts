// @ts-strict-ignore
import { errorFileFor } from '@actual-app/error-file';

import * as asyncStorage from '#platform/server/asyncStorage';
import { createApp } from '#server/app';
import { PostError } from '#server/errors';
import { del, get, patch, post } from '#server/post';
import { getServer } from '#server/server-config';
import type {
  NewUserAccessEntity,
  UserAvailable,
  UserEntity,
} from '#types/models';

const errors = errorFileFor('loot-core/src/server/admin/app.ts');

// A PostError carrying one of these reasons means the server could not be reached or did not
// answer sensibly: a fault. Any other reason (unauthorized, a refused user or access change) is the
// server's answer to the request, not a fault (R7).
const POST_FAULT_REASONS = new Set([
  'network-failure',
  'parse-json',
  'internal',
  'unknown',
]);

function isServerAnswer(err: unknown): boolean {
  return err instanceof PostError && !POST_FAULT_REASONS.has(err.reason);
}

export type AdminHandlers = {
  'users-get': typeof getUsers;
  'user-delete-all': typeof deleteAllUsers;
  'user-add': typeof addUser;
  'user-update': typeof updateUser;
  'access-add': typeof addAccess;
  'access-delete-all': typeof deleteAllAccess;
  'access-get-available-users': typeof accessGetAvailableUsers;
  'transfer-ownership': typeof transferOwnership;
  'owner-created': typeof ownerCreated;
};

// Expose functions to the client
export const app = createApp<AdminHandlers>();

app.method('users-get', getUsers);
app.method('user-delete-all', deleteAllUsers);
app.method('user-add', addUser);
app.method('user-update', updateUser);
app.method('access-add', addAccess);
app.method('access-delete-all', deleteAllAccess);
app.method('access-get-available-users', accessGetAvailableUsers);
app.method('transfer-ownership', transferOwnership);
app.method('owner-created', ownerCreated);

async function getUsers() {
  const userToken = await asyncStorage.getItem('user-token');

  if (userToken) {
    const res = await get(getServer().BASE_SERVER + '/admin/users/', {
      headers: {
        'X-ACTUAL-TOKEN': userToken,
      },
    });

    if (res) {
      try {
        const list = JSON.parse(res) as UserEntity[];
        return list;
      } catch (err) {
        errors.caught('parsing the admin users response', err);
        return { error: 'Failed to parse response: ' + err.message };
      }
    }
  }

  return null;
}

async function deleteAllUsers(
  ids: Array<UserEntity['id']>,
): Promise<
  { someDeletionsFailed: boolean; ids?: number[] } | { error: string }
> {
  const userToken = await asyncStorage.getItem('user-token');
  if (userToken) {
    try {
      const res = await del(
        getServer().BASE_SERVER + '/admin/users',
        {
          ids,
        },
        {
          'X-ACTUAL-TOKEN': userToken,
        },
      );

      if (res) {
        return res;
      }
    } catch (err) {
      if (isServerAnswer(err)) {
        errors.expected('deleting users on the server', err);
      } else {
        errors.caught('deleting users on the server', err);
      }
      return { error: err.reason };
    }
  }

  return { someDeletionsFailed: true };
}

async function addUser(
  user: Omit<UserEntity, 'id'>,
): Promise<{ error: string } | { id: string }> {
  const userToken = await asyncStorage.getItem('user-token');

  if (userToken) {
    try {
      const res = await post(getServer().BASE_SERVER + '/admin/users/', user, {
        'X-ACTUAL-TOKEN': userToken,
      });

      return res as UserEntity;
    } catch (err) {
      if (isServerAnswer(err)) {
        errors.expected('adding a user on the server', err);
      } else {
        errors.caught('adding a user on the server', err);
      }
      return { error: err.reason };
    }
  }

  return null;
}

async function updateUser(
  user: Omit<UserEntity, 'id'>,
): Promise<{ error: string } | { id: string }> {
  const userToken = await asyncStorage.getItem('user-token');

  if (userToken) {
    try {
      const res = await patch(getServer().BASE_SERVER + '/admin/users/', user, {
        'X-ACTUAL-TOKEN': userToken,
      });

      return res as UserEntity;
    } catch (err) {
      if (isServerAnswer(err)) {
        errors.expected('updating a user on the server', err);
      } else {
        errors.caught('updating a user on the server', err);
      }
      return { error: err.reason };
    }
  }

  return null;
}

async function addAccess(
  access: NewUserAccessEntity,
): Promise<{ error?: string } | Record<string, never>> {
  const userToken = await asyncStorage.getItem('user-token');

  if (userToken) {
    try {
      await post(getServer().BASE_SERVER + '/admin/access/', access, {
        'X-ACTUAL-TOKEN': userToken,
      });

      return {};
    } catch (err) {
      if (isServerAnswer(err)) {
        errors.expected('adding file access on the server', err);
      } else {
        errors.caught('adding file access on the server', err);
      }
      return { error: err.reason };
    }
  }

  return null;
}

async function deleteAllAccess({
  fileId,
  ids,
}: {
  fileId: string;
  ids: string[];
}): Promise<
  { someDeletionsFailed: boolean; ids?: number[] } | { error: unknown }
> {
  const userToken = await asyncStorage.getItem('user-token');
  if (userToken) {
    try {
      const res = await del(
        getServer().BASE_SERVER + `/admin/access?fileId=${fileId}`,
        {
          token: userToken,
          ids,
        },
      );

      if (res) {
        return res;
      }
    } catch (err) {
      if (isServerAnswer(err)) {
        errors.expected('deleting file access on the server', err);
      } else {
        errors.caught('deleting file access on the server', err);
      }
      return { error: err.reason };
    }
  }

  return { someDeletionsFailed: true };
}

async function accessGetAvailableUsers(
  fileId: string,
): Promise<UserAvailable[] | { error: string }> {
  const userToken = await asyncStorage.getItem('user-token');

  if (userToken) {
    const res = await get(
      `${getServer().BASE_SERVER + '/admin/access/users'}?fileId=${fileId}`,
      {
        headers: {
          'X-ACTUAL-TOKEN': userToken,
        },
      },
    );

    if (res) {
      try {
        return JSON.parse(res) as UserAvailable[];
      } catch (err) {
        errors.caught('parsing the available users response', err);
        return { error: 'Failed to parse response: ' + err.message };
      }
    }
  }

  return [];
}

async function transferOwnership({
  fileId,
  newUserId,
}: {
  fileId: string;
  newUserId: string;
}): Promise<{ error?: string } | Record<string, never>> {
  const userToken = await asyncStorage.getItem('user-token');

  if (userToken) {
    try {
      await post(
        getServer().BASE_SERVER + '/admin/access/transfer-ownership/',
        { fileId, newUserId },
        {
          'X-ACTUAL-TOKEN': userToken,
        },
      );
    } catch (err) {
      if (isServerAnswer(err)) {
        errors.expected('transferring file ownership on the server', err);
      } else {
        errors.caught('transferring file ownership on the server', err);
      }
      return { error: err.reason };
    }
  }

  return {};
}

async function ownerCreated() {
  const res = await get(getServer().BASE_SERVER + '/admin/owner-created/');

  if (res) {
    return JSON.parse(res) as boolean;
  }

  return null;
}
