import {
  BATCH_DELAY_MS,
  BATCH_SIZE,
  CLIENT_BUDGET_PER_MINUTE,
  installBrowserErrorFile,
  isBenignBrowserError,
  resetBrowserErrorFileForTests,
} from './browser.ts';
import type { BrowserReportBody, BrowserScope } from './browser.ts';
import {
  errorFileFor,
  flushErrorFile,
  resetErrorFileForTests,
} from './core.ts';

type FakeScope = BrowserScope & {
  listeners: Map<string, ((event: unknown) => void)[]>;
  posts: BrowserReportBody[];
  beacons: string[];
  emit(type: string, event: unknown): void;
};

function parseBody(text: string): BrowserReportBody {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('events' in parsed)) {
    throw new Error('bad body');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test decoding
  return parsed as BrowserReportBody;
}

function fakeScope(fetchImpl?: () => Promise<unknown>): FakeScope {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const posts: BrowserReportBody[] = [];
  const beacons: string[] = [];
  return {
    listeners,
    posts,
    beacons,
    document: { visibilityState: 'visible' },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type, event) {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    fetch: (_url, init) => {
      posts.push(parseBody(String(init.body)));
      return fetchImpl ? fetchImpl() : Promise.resolve({});
    },
    navigator: {
      sendBeacon: (_url, data) => {
        beacons.push(typeof data === 'string' ? data : 'blob');
        return true;
      },
    },
  };
}

const errors = errorFileFor('error-file/src/browser.test.ts');

beforeEach(() => {
  resetBrowserErrorFileForTests();
  resetErrorFileForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('browser sink', () => {
  it('batches at 20 records', () => {
    const scope = fakeScope();
    installBrowserErrorFile({ app: 'web', scope });
    for (let i = 0; i < BATCH_SIZE; i++) {
      errorFileFor(`w${i}`).caught('clicking', new Error('x'));
    }
    expect(scope.posts).toHaveLength(1);
    expect(scope.posts[0]?.events).toHaveLength(BATCH_SIZE);
    expect(scope.posts[0]?.app).toBe('web');
  });

  it('batches after 2 s', () => {
    const scope = fakeScope();
    installBrowserErrorFile({ app: 'worker', scope });
    errors.caught('handling a message', new Error('x'));
    expect(scope.posts).toHaveLength(0);
    vi.advanceTimersByTime(BATCH_DELAY_MS);
    expect(scope.posts).toHaveLength(1);
  });

  it('uses sendBeacon on pagehide', () => {
    const scope = fakeScope();
    installBrowserErrorFile({ app: 'web', scope });
    errors.caught('closing the tab', new Error('x'));
    scope.emit('pagehide', {});
    expect(scope.beacons).toHaveLength(1);
    expect(scope.posts).toHaveLength(0);
  });

  it('enforces the client budget and sends one summary', () => {
    const sent: BrowserReportBody[] = [];
    installBrowserErrorFile({
      app: 'web',
      scope: fakeScope(),
      transport: b => sent.push(b),
    });
    for (let i = 0; i < CLIENT_BUDGET_PER_MINUTE + 10; i++) {
      errorFileFor(`w${i}`).caught('looping', new Error(`distinct ${i}`));
    }
    flushErrorFile();
    const events = sent.flatMap(b => b.events);
    expect(events).toHaveLength(CLIENT_BUDGET_PER_MINUTE + 1);
    expect(events.at(-1)?.error).toBe(
      `10 records dropped over the client budget of ${CLIENT_BUDGET_PER_MINUTE}/min`,
    );
  });

  it('never re-queues a delivery failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scope = fakeScope(() => Promise.reject(new Error('offline')));
    installBrowserErrorFile({ app: 'web', scope });
    errors.caught('saving', new Error('x'));
    vi.advanceTimersByTime(BATCH_DELAY_MS);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(BATCH_DELAY_MS * 3);
    expect(scope.posts).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reports window errors and rejections, ignoring ResizeObserver noise', () => {
    const scope = fakeScope();
    installBrowserErrorFile({
      app: 'web',
      scope,
      where: 'desktop-client/src/index.tsx',
    });
    scope.emit('error', {
      error: null,
      message: 'ResizeObserver loop completed with undelivered notifications.',
    });
    scope.emit('error', { error: new TypeError('real'), message: 'real' });
    scope.emit('unhandledrejection', { reason: new Error('rejected') });
    vi.advanceTimersByTime(BATCH_DELAY_MS);
    const events = scope.posts.flatMap(p => p.events);
    expect(events.map(e => e.doing)).toEqual([
      'an uncaught error',
      'an unhandled promise rejection',
    ]);
    expect(events[0]?.where).toBe('desktop-client/src/index.tsx');
    expect(
      isBenignBrowserError({ filename: 'http://localhost:3001/@vite/client' }),
    ).toBe(true);
  });

  it('uses the transport when one is given (Electron IPC)', () => {
    const sent: BrowserReportBody[] = [];
    const scope = fakeScope();
    installBrowserErrorFile({
      app: 'electron-renderer',
      scope,
      transport: b => sent.push(b),
    });
    errors.caught('rendering', new Error('x'));
    vi.advanceTimersByTime(BATCH_DELAY_MS);
    expect(sent).toHaveLength(1);
    expect(scope.posts).toHaveLength(0);
  });
});
