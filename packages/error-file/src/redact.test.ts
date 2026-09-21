import { errorFileFor, resetErrorFileForTests, setErrorSink } from './core.ts';
import { LEDGER_REFUSED, redactData, REDACTED, redactUrls } from './redact.ts';
import { memorySink } from './test-sink.ts';

// Synthetic corpus only — never a real value (§11.6).
const SECRET_KEYS = [
  'password',
  'pass',
  'clientSecret',
  'accessToken',
  'Authorization',
  'cookie',
  'sessionId',
  'apiKey',
  'signature',
  'credentials',
  'bearer',
];
const LEDGER_KEYS = [
  'amount',
  'balance',
  'payee',
  'payeeName',
  'notes',
  'note',
  'memo',
  'account_name',
  'accountName',
  'category_name',
  'categoryName',
  'description',
  'imported_payee',
  'statementText',
];
const SYNTHETIC = 'SYNTHETIC-VALUE-9f3a';

describe('redact (§11, M10)', () => {
  it('redacts every secret key', () => {
    const out = redactData(
      Object.fromEntries(SECRET_KEYS.map(k => [k, SYNTHETIC])),
    );
    for (const key of SECRET_KEYS) expect(out?.[key]).toBe(REDACTED);
  });

  it('refuses every ledger key', () => {
    const out = redactData(
      Object.fromEntries(LEDGER_KEYS.map(k => [k, SYNTHETIC])),
    );
    for (const key of LEDGER_KEYS) expect(out?.[key]).toBe(LEDGER_REFUSED);
  });

  it('lets opaque ids, counts and booleans through', () => {
    expect(
      redactData({ accountId: 'acct-1', count: 3, ok: true, gone: undefined }),
    ).toEqual({
      accountId: 'acct-1',
      count: '3',
      ok: 'true',
    });
  });

  it('redacts URL query values but keeps the names', () => {
    expect(
      redactUrls(
        'GET https://bank.example/cb?code=abc&state=xyz&page=2&sig=zz#frag failed',
      ),
    ).toBe(
      'GET https://bank.example/cb?code=[redacted]&state=[redacted]&page=2&sig=[redacted]#frag failed',
    );
  });

  it('no secret or ledger value reaches a written line', () => {
    resetErrorFileForTests();
    const sink = memorySink();
    setErrorSink(sink);
    const data = Object.fromEntries(
      [...SECRET_KEYS, ...LEDGER_KEYS].map(k => [k, SYNTHETIC]),
    );
    errorFileFor('x').caught(
      'posting a synthetic request',
      new Error(`fetch https://h.example/?token=${SYNTHETIC} failed`),
      data,
    );
    expect(sink.lines().join('')).not.toContain(SYNTHETIC);
  });
});
