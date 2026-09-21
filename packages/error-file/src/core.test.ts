import {
  errorFileFor,
  flushErrorFile,
  guard,
  isReported,
  PRE_INSTALL_CAP,
  reportBoundaryError,
  reportRejection,
  resetErrorFileForTests,
  setErrorSink,
  tryOr,
  tryOrAsync,
} from './core.ts';
import { memorySink } from './test-sink.ts';

const errors = errorFileFor('error-file/src/core.test.ts');

beforeEach(() => {
  resetErrorFileForTests();
  vi.unstubAllEnvs();
});

describe('dedupe (R4)', () => {
  it('rethrow ×3, then captureException-style caught, then the process net → 1 line', () => {
    const sink = memorySink();
    setErrorSink(sink);
    const err = new Error('deep failure');
    const layer = (n: number): void => {
      try {
        if (n === 0) throw err;
        layer(n - 1);
      } catch (e) {
        errors.rethrow(`running layer ${n}`, e);
      }
    };
    expect(() => layer(2)).toThrow(err);
    errors.caught('capturing an exception', err);
    errorFileFor('sync-server (process)').fatal('an uncaught exception', err);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.doing).toBe('running layer 0');
    expect(isReported(err)).toBe(true);
  });

  it('rethrow throws the same object, not a wrapper (R5)', () => {
    setErrorSink(memorySink());
    const err = Object.assign(new Error('typed'), { type: 'APIError' });
    let caught: unknown;
    try {
      errors.rethrow('doing a thing', err);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });
});

describe('expected (R6)', () => {
  it('writes nothing by default', () => {
    const sink = memorySink();
    setErrorSink(sink);
    errors.expected('reading the optional config.json', new Error('ENOENT'));
    flushErrorFile();
    expect(sink.records).toHaveLength(0);
  });

  it('writes EXPECTED under ACTUAL_ERROR_FILE_VERBOSE=1', () => {
    vi.stubEnv('ACTUAL_ERROR_FILE_VERBOSE', '1');
    const sink = memorySink();
    setErrorSink(sink);
    errors.expected('reading the optional config.json', new Error('ENOENT'));
    expect(sink.records[0]?.level).toBe('EXPECTED');
  });
});

describe('pre-install queue', () => {
  it('holds records reported before install and writes them on install', () => {
    errors.caught('booting before the sink', new Error('early'));
    const sink = memorySink('sync-server');
    setErrorSink(sink);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.app).toBe('sync-server');
  });

  it('counts overflow and writes one WARN about it', () => {
    for (let i = 0; i < PRE_INSTALL_CAP + 7; i++) {
      errorFileFor(`where-${i}`).caught('booting', new Error(`e${i}`));
    }
    const sink = memorySink();
    setErrorSink(sink);
    expect(sink.records).toHaveLength(PRE_INSTALL_CAP + 1);
    expect(sink.records.at(-1)?.error).toBe(
      '7 records were dropped before the error file was installed',
    );
  });
});

describe('totality (R11)', () => {
  it('a throwing sink returns normally', () => {
    const sink = memorySink();
    sink.write = () => {
      throw new Error('sink broke');
    };
    setErrorSink(sink);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => errors.caught('doing', new Error('x'))).not.toThrow();
    spy.mockRestore();
  });

  it('a throwing toString and a circular data value return normally', () => {
    const sink = memorySink();
    setErrorSink(sink);
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately bad input
    const data = circular as unknown as Record<string, string>;
    expect(() => errors.caught('doing', hostile, data)).not.toThrow();
    expect(sink.records).toHaveLength(1);
  });

  it('re-entrancy drops the record instead of looping', () => {
    const sink = memorySink();
    const inner = errorFileFor('inner');
    sink.write = record => {
      sink.records.push(record);
      inner.caught('reporting from inside the sink', new Error('loop'));
    };
    setErrorSink(sink);
    errors.caught('outer', new Error('first'));
    expect(sink.records).toHaveLength(1);
  });
});

describe('wrappers', () => {
  it('tryOr returns the fallback and reports', () => {
    const sink = memorySink();
    setErrorSink(sink);
    expect(
      tryOr(errors, 'parsing the widget settings', () => JSON.parse('{'), null),
    ).toBe(null);
    expect(tryOr(errors, 'parsing', () => 5, 0)).toBe(5);
    expect(sink.records).toHaveLength(1);
  });

  it('tryOrAsync resolves the fallback and reports', async () => {
    const sink = memorySink();
    setErrorSink(sink);
    await expect(
      tryOrAsync(
        errors,
        'fetching rates',
        () => Promise.reject(new Error('no')),
        [],
      ),
    ).resolves.toEqual([]);
    expect(sink.records).toHaveLength(1);
  });

  it('reportRejection reports a fire-and-forget rejection', async () => {
    const sink = memorySink();
    setErrorSink(sink);
    reportRejection(
      errors,
      'refreshing the list',
      Promise.reject(new Error('gone')),
    );
    await new Promise(r => setTimeout(r, 0));
    expect(sink.records[0]?.doing).toBe('refreshing the list');
  });

  it('guard reports sync throws and async rejections and returns void', async () => {
    const sink = memorySink();
    setErrorSink(sink);
    const sync = guard(errors, 'handling a click', () => {
      throw new Error('sync');
    });
    const async = guard(errors, 'handling a message', async () => {
      throw new Error('async');
    });
    expect(sync()).toBeUndefined();
    expect(async()).toBeUndefined();
    await new Promise(r => setTimeout(r, 0));
    expect(sink.records.map(r => r.error)).toEqual([
      'Error: sync',
      'Error: async',
    ]);
  });

  it('reportBoundaryError puts the component stack first', () => {
    const sink = memorySink();
    setErrorSink(sink);
    const onError = reportBoundaryError(errors, 'rendering the app shell');
    const err = new Error('render');
    err.stack =
      'Error: render\n    at render (http://localhost:3001/src/App.tsx:1:1)';
    onError(err, { componentStack: '\n    at AppInner\n    at ErrorBoundary' });
    expect(sink.records[0]?.stack.split('\n')).toEqual([
      '    at AppInner',
      '    at ErrorBoundary',
      '    at render (src/App.tsx:1:1)',
    ]);
  });

  it('a network failure is a WARN, not an ERROR (§10.2)', () => {
    const sink = memorySink();
    setErrorSink(sink);
    errors.caught(
      'syncing the budget',
      Object.assign(new Error('PostError: network-failure'), {
        reason: 'network-failure',
      }),
    );
    expect(sink.records[0]?.level).toBe('WARN');
  });
});
