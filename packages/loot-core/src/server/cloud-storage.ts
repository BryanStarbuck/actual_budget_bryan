// @ts-strict-ignore
import { errorFileFor, reportRejection } from '@actual-app/error-file';
import { v4 as uuidv4 } from 'uuid';

import * as asyncStorage from '#platform/server/asyncStorage';
import { fetch } from '#platform/server/fetch';
import * as fs from '#platform/server/fs';
import * as memory from '#platform/server/memory';
import * as sqlite from '#platform/server/sqlite';
import * as monthUtils from '#shared/months';

import * as encryption from './encryption';
import {
  FileDownloadError,
  FileUploadError,
  HTTPError,
  PostError,
} from './errors';
import { runMutator } from './mutators';
import { getServerErrorReason, post } from './post';
import * as prefs from './prefs';
import { getServer } from './server-config';
import {
  exceedsSafeUnzipLimits,
  safeUnzip,
  safeZip,
  UnsafeZipError,
} from './util/zip';

const errors = errorFileFor('loot-core/src/server/cloud-storage.ts');

const UPLOAD_FREQUENCY_IN_DAYS = 7;

export type UsersWithAccess = {
  userId: string;
  userName: string;
  displayName: string;
  owner: boolean;
};
export type RemoteFile = {
  deleted: boolean;
  fileId: string;
  groupId: string;
  name: string;
  encryptKeyId: string;
  hasKey: boolean;
  owner: string;
  usersWithAccess: UsersWithAccess[];
};

async function checkHTTPStatus(res) {
  if (res.status === 200) {
    return res;
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    try {
      const body = JSON.parse(text);
      const error = res.status === 403 ? body.data : body;
      if (getServerErrorReason(error) === 'token-expired') {
        await asyncStorage.removeItem('user-token');
      }
    } catch (e) {
      // Preserve the original HTTP error when the response is not JSON.
      errors.expected('parsing the unauthorized response body', e);
    }
  }

  throw new HTTPError(res.status, text);
}

async function fetchJSON(...args: Parameters<typeof fetch>) {
  let res = await fetch(...args);
  res = await checkHTTPStatus(res);
  return res.json();
}

export async function checkKey(): Promise<{
  valid: boolean;
  error?: { reason: string };
}> {
  const userToken = await asyncStorage.getItem('user-token');

  const { cloudFileId, encryptKeyId } = prefs.getPrefs();

  let res;
  try {
    res = await post(getServer().SYNC_SERVER + '/user-get-key', {
      token: userToken,
      fileId: cloudFileId,
    });
  } catch (e) {
    errors.caught('checking the encryption key with the server', e);
    return { valid: false, error: { reason: 'network' } };
  }

  return {
    valid:
      // This == comparison is important, they could be null or undefined
      // oxlint-disable-next-line eslint/eqeqeq
      res.id == encryptKeyId &&
      (encryptKeyId == null || encryption.hasKey(encryptKeyId)),
  };
}

export async function resetSyncState(newKeyState) {
  const userToken = await asyncStorage.getItem('user-token');

  const { cloudFileId } = prefs.getPrefs();

  try {
    await post(getServer().SYNC_SERVER + '/reset-user-file', {
      token: userToken,
      fileId: cloudFileId,
    });
  } catch (e) {
    if (e instanceof PostError) {
      if (e.reason === 'unauthorized') {
        errors.expected('resetting the sync state on the server', e);
      } else {
        errors.caught('resetting the sync state on the server', e);
      }
      return {
        error: {
          reason: e.reason === 'unauthorized' ? 'unauthorized' : 'network',
        },
      };
    }
    errors.caught('resetting the sync state on the server', e);
    return { error: { reason: 'internal' } };
  }

  if (newKeyState) {
    try {
      await post(getServer().SYNC_SERVER + '/user-create-key', {
        token: userToken,
        fileId: cloudFileId,
        keyId: newKeyState.key.getId(),
        keySalt: newKeyState.salt,
        testContent: newKeyState.testContent,
      });
    } catch (e) {
      errors.caught('creating the encryption key on the server', e);
      if (e instanceof PostError) {
        return { error: { reason: 'network' } };
      }
      return { error: { reason: 'internal' } };
    }
  }

  return {};
}

export async function exportBuffer() {
  const { id, budgetName } = prefs.getPrefs();
  if (!budgetName) {
    return null;
  }

  const budgetDir = fs.getBudgetDir(id);

  // We run this in a mutator even though its not mutating anything
  // because we are reading the sqlite file from disk. We want to make
  // sure that we get a valid snapshot of it so we want this to be
  // serialized with all other mutations.
  const { zipped, entries } = await runMutator(async () => {
    const rawDbContent = await fs.readFile(
      fs.join(budgetDir, 'db.sqlite'),
      'binary',
    );

    // Do some post-processing of the database. We NEVER upload the cache with
    // the database; this forces new downloads to always recompute everything
    // which is not only safer, but reduces the filesize a lot.
    const memDb = await sqlite.openDatabase(rawDbContent);
    sqlite.execQuery(
      memDb,
      `
        DELETE FROM kvcache;
        DELETE FROM kvcache_key;
      `,
    );

    const dbContent = await sqlite.exportDatabase(memDb);

    sqlite.closeDatabase(memDb);

    // mark it as a file that needs a new clock so when a new client
    // downloads it, it'll get set to a unique node
    const meta = JSON.parse(
      await fs.readFile(fs.join(budgetDir, 'metadata.json')),
    );

    meta.resetClock = true;
    const metaContent = Buffer.from(JSON.stringify(meta), 'utf8');

    const entries = {
      'db.sqlite': Buffer.from(dbContent),
      'metadata.json': metaContent,
    };

    return { zipped: safeZip(entries), entries };
  });

  const warnings: string[] = [];
  if (exceedsSafeUnzipLimits(zipped, entries)) {
    warnings.push('exceeds-import-size-limit');
  }

  const availableMemory = memory.getAvailableMemory();
  if (
    availableMemory != null &&
    entries['db.sqlite'].length > availableMemory
  ) {
    warnings.push('may-exceed-available-memory');
  }

  return { data: Buffer.from(zipped), warnings };
}

export async function importBuffer(fileData, buffer) {
  let entries;
  try {
    entries = safeUnzip(buffer);
  } catch (e) {
    if (e instanceof UnsafeZipError) {
      // A refused oversize archive is an answer, not a fault (R7).
      errors.expected('unzipping the downloaded budget file', e);
      throw FileDownloadError('zip-too-large', e.meta);
    }
    errors.caught('unzipping the downloaded budget file', e);
    throw FileDownloadError('not-zip-file');
  }
  const entryNames = Object.keys(entries);
  const dbDirs = entryNames
    .filter(name => name === 'db.sqlite' || name.endsWith('/db.sqlite'))
    .map(name => name.slice(0, -'db.sqlite'.length));
  const metaDirs = entryNames
    .filter(name => name === 'metadata.json' || name.endsWith('/metadata.json'))
    .map(name => name.slice(0, -'metadata.json'.length));

  // Both files must come from the same directory: prefer the archive root,
  // otherwise there must be exactly one directory containing both.
  const sharedDirs = dbDirs.filter(dir => metaDirs.includes(dir));
  const dir = sharedDirs.includes('')
    ? ''
    : sharedDirs.length === 1
      ? sharedDirs[0]
      : null;

  if (dir == null) {
    throw FileDownloadError('invalid-zip-file');
  }

  const entryName = dir + 'db.sqlite';
  const metaEntryName = dir + 'metadata.json';

  const dbContent = Buffer.from(entries[entryName]);
  const metaContent = Buffer.from(entries[metaEntryName]);

  let meta;
  try {
    meta = JSON.parse(metaContent.toString('utf8'));
  } catch (e) {
    errors.caught('parsing the downloaded metadata.json', e);
    throw FileDownloadError('invalid-meta-file');
  }

  // Update the metadata. The stored file on the server might be
  // out-of-date with a few keys
  meta = {
    ...meta,
    cloudFileId: fileData.fileId,
    groupId: fileData.groupId,
    lastUploaded: monthUtils.currentDay(),
    encryptKeyId: fileData.encryptMeta ? fileData.encryptMeta.keyId : null,
  };

  const budgetDir = fs.getBudgetDir(meta.id);

  if (await fs.exists(budgetDir)) {
    // Don't remove the directory so that backups are retained
    const dbFile = fs.join(budgetDir, 'db.sqlite');
    const metaFile = fs.join(budgetDir, 'metadata.json');

    if (await fs.exists(dbFile)) {
      await fs.removeFile(dbFile);
    }
    if (await fs.exists(metaFile)) {
      await fs.removeFile(metaFile);
    }
  } else {
    await fs.mkdir(budgetDir);
  }

  await fs.writeFile(fs.join(budgetDir, 'db.sqlite'), dbContent);
  await fs.writeFile(fs.join(budgetDir, 'metadata.json'), JSON.stringify(meta));

  return { id: meta.id };
}

export async function upload() {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    throw FileUploadError('unauthorized');
  }

  const exported = await exportBuffer();
  if (exported == null) {
    return;
  }
  const zipContent = exported.data;

  const {
    id,
    groupId,
    budgetName,
    cloudFileId: originalCloudFileId,
    encryptKeyId,
  } = prefs.getPrefs();
  let cloudFileId = originalCloudFileId;
  let uploadContent = zipContent;
  let uploadMeta = null;

  // The upload process encrypts with the key tagged in the prefs for
  // the file. It will upload the file and the server is responsible
  // for checking that the key is up-to-date and rejecting it if not
  if (encryptKeyId) {
    let encrypted;
    try {
      encrypted = await encryption.encrypt(zipContent, encryptKeyId);
    } catch (e) {
      const isMissingKey = e.message === 'missing-key';
      if (isMissingKey) {
        // The key has not been entered yet; the UI asks for it.
        errors.expected('encrypting the budget file for upload', e);
      } else {
        errors.caught('encrypting the budget file for upload', e);
      }
      throw FileUploadError('encrypt-failure', { isMissingKey });
    }
    uploadContent = encrypted.value;
    uploadMeta = encrypted.meta;
  }

  if (!cloudFileId) {
    cloudFileId = uuidv4();
  }

  let res;
  try {
    res = await fetchJSON(getServer().SYNC_SERVER + '/upload-user-file', {
      method: 'POST',
      headers: {
        'Content-Length': String(uploadContent.length),
        'Content-Type': 'application/encrypted-file',
        'X-ACTUAL-TOKEN': userToken,
        'X-ACTUAL-FILE-ID': cloudFileId,
        'X-ACTUAL-NAME': encodeURIComponent(budgetName),
        'X-ACTUAL-FORMAT': '2',
        ...(uploadMeta
          ? { 'X-ACTUAL-ENCRYPT-META': JSON.stringify(uploadMeta) }
          : null),
        ...(groupId ? { 'X-ACTUAL-GROUP-ID': groupId } : null),
        // TODO: fix me
        // oxlint-disable-next-line typescript/no-explicit-any
      },
      body: uploadContent,
    });
  } catch (err) {
    if (err instanceof PostError && err.reason === 'unauthorized') {
      // Signed out: an answer, not a fault (R7).
      errors.expected('uploading the budget file', err);
    } else {
      errors.caught('uploading the budget file', err);
    }

    if (err instanceof PostError) {
      throw FileUploadError(
        err.reason === 'unauthorized'
          ? 'unauthorized'
          : err.reason || 'network',
      );
    }

    throw FileUploadError('internal');
  }

  if (res.status === 'ok') {
    // Only save it if we are still working on the same file
    if (prefs.getPrefs() && prefs.getPrefs().id === id) {
      await prefs.savePrefs({
        lastUploaded: monthUtils.currentDay(),
        cloudFileId,
        groupId: res.groupId,
      });
    }
  } else {
    throw FileUploadError('internal');
  }
}

export async function possiblyUpload() {
  const { cloudFileId, groupId, lastUploaded } = prefs.getPrefs();

  const threshold =
    lastUploaded && monthUtils.addDays(lastUploaded, UPLOAD_FREQUENCY_IN_DAYS);
  const currentDay = monthUtils.currentDay();

  // We only want to try to upload every UPLOAD_FREQUENCY_IN_DAYS days
  if (lastUploaded && currentDay < threshold) {
    return;
  }

  // We only want to upload existing cloud files that are part of a
  // valid group
  if (!cloudFileId || !groupId) {
    return;
  }

  // Don't block on uploading
  reportRejection(errors, 'uploading the budget on its schedule', upload());
}

export async function removeFile(fileId) {
  const userToken = await asyncStorage.getItem('user-token');

  await post(getServer().SYNC_SERVER + '/delete-user-file', {
    token: userToken,
    fileId,
  });
}

export async function listRemoteFiles(): Promise<RemoteFile[]> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return null;
  }

  let res;
  try {
    res = await fetchJSON(getServer().SYNC_SERVER + '/list-user-files', {
      headers: {
        'X-ACTUAL-TOKEN': userToken,
      },
    });
  } catch (e) {
    errors.caught('listing the remote budget files', e);
    return null;
  }

  if (res.status === 'error') {
    errors.warn('listing the remote budget files', undefined, {
      reason: getServerErrorReason(res),
    });
    return null;
  }

  return res.data
    .map(file => ({
      ...file,
      hasKey: encryption.hasKey(file.encryptKeyId),
    }))
    .filter(Boolean);
}

export async function download(cloudFileId) {
  const userToken = await asyncStorage.getItem('user-token');
  const syncServer = getServer().SYNC_SERVER;

  const userFileFetch = fetch(`${syncServer}/download-user-file`, {
    headers: {
      'X-ACTUAL-TOKEN': userToken,
      'X-ACTUAL-FILE-ID': cloudFileId,
    },
  })
    .then(checkHTTPStatus)
    .then(res => {
      if (res.arrayBuffer) {
        return res.arrayBuffer().then(ab => Buffer.from(ab));
      }
      return res.buffer();
    })
    .catch(err => {
      errors.caught('downloading the budget file', err);
      throw FileDownloadError('download-failure');
    });

  const userFileInfoFetch = fetchJSON(`${syncServer}/get-user-file-info`, {
    headers: {
      'X-ACTUAL-TOKEN': userToken,
      'X-ACTUAL-FILE-ID': cloudFileId,
    },
  }).catch(err => {
    errors.caught('fetching the remote file info', err, {
      fileId: cloudFileId,
    });
    throw FileDownloadError('internal', { fileId: cloudFileId });
  });

  const [userFileInfoRes, userFileRes] = await Promise.all([
    userFileInfoFetch,
    userFileFetch,
  ]);

  if (userFileInfoRes.status !== 'ok') {
    // The server has no such file: the file ID is probably wrong.
    errors.warn('fetching the remote file info', undefined, {
      fileId: cloudFileId,
      reason: getServerErrorReason(userFileInfoRes),
    });
    throw FileDownloadError('internal', { fileId: cloudFileId });
  }

  const fileData = userFileInfoRes.data;
  let buffer = userFileRes;

  // The download process checks if the server gave us decrypt
  // information. It is assumed that this key has already been loaded
  // in, which is done in a previous step
  if (fileData.encryptMeta) {
    try {
      buffer = await encryption.decrypt(buffer, fileData.encryptMeta);
    } catch (e) {
      const isMissingKey = e.message === 'missing-key';
      if (isMissingKey) {
        // The key has not been entered yet; the UI asks for it.
        errors.expected('decrypting the downloaded budget file', e);
      } else {
        errors.caught('decrypting the downloaded budget file', e);
      }
      throw FileDownloadError('decrypt-failure', { isMissingKey });
    }
  }

  return importBuffer(fileData, buffer);
}
