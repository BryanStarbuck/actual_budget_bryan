import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { resetErrorFileForTests, setErrorSink } from './core.ts';
import {
  BODY_CAP,
  createErrorReportHandler,
  createIngest,
  EVENTS_PER_REQUEST,
  RATE_PER_CLIENT,
} from './ingest.ts';
import { memorySink } from './test-sink.ts';

type FakeRes = {
  statusCode: number;
  ended: boolean;
  body: string;
  headersSent: boolean;
};

function call(
  handler: ReturnType<typeof createErrorReportHandler>,
  opts: { address?: string; type?: string; body: string },
): Promise<FakeRes> {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: { 'content-type': opts.type ?? 'application/json' },
    socket: { remoteAddress: opts.address ?? '127.0.0.1' },
    resume() {
      // a fake IncomingMessage has nothing to resume
    },
  });
  return new Promise(resolve => {
    const res: FakeRes & { end: (chunk?: string) => void } = {
      statusCode: 200,
      ended: false,
      body: '',
      headersSent: false,
      end(chunk?: string) {
        this.ended = true;
        this.body = chunk ?? '';
        resolve(this);
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minimal fakes
    handler(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    req.emit('data', Buffer.from(opts.body));
    req.emit('end');
  });
}

function event(i = 0): Record<string, unknown> {
  return {
    ts: '2026-09-21T16:04:11.902Z',
    level: 'ERROR',
    where: 'desktop-client/src/components/App.tsx',
    doing: 'rendering the app shell',
    error: `TypeError: synthetic ${i}`,
    stack: '    at App (src/App.tsx:1:1)',
    data: { token: 'SYNTHETIC-SECRET', accountId: 'a1' },
  };
}

beforeEach(() => resetErrorFileForTests());

describe('ingest', () => {
  it('non-loopback → 204, no write', async () => {
    const sink = memorySink();
    setErrorSink(sink);
    const res = await call(createErrorReportHandler({ via: 'vite' }), {
      address: '10.0.0.5',
      body: JSON.stringify({ app: 'web', events: [event()] }),
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(sink.records).toHaveLength(0);
  });

  it('writes a loopback report, tagged via, re-redacted, always 204', async () => {
    const sink = memorySink();
    setErrorSink(sink);
    const res = await call(createErrorReportHandler({ via: 'sync-server' }), {
      address: '::ffff:127.0.0.1',
      type: 'text/plain;charset=UTF-8',
      body: JSON.stringify({ app: 'web', events: [event()] }),
    });
    expect(res.statusCode).toBe(204);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.app).toBe('web');
    expect(sink.records[0]?.data).toEqual({
      token: '[redacted]',
      accountId: 'a1',
      via: 'sync-server',
    });
  });

  it('drops a body over the size cap and a wrong content type', async () => {
    const sink = memorySink();
    setErrorSink(sink);
    const handler = createErrorReportHandler({ via: 'vite' });
    const big = JSON.stringify({
      app: 'web',
      events: [{ ...event(), error: 'x'.repeat(BODY_CAP) }],
    });
    expect((await call(handler, { body: big })).statusCode).toBe(204);
    expect(
      (
        await call(handler, {
          type: 'image/png',
          body: JSON.stringify({ app: 'web', events: [event()] }),
        })
      ).statusCode,
    ).toBe(204);
    expect(sink.records).toHaveLength(0);
  });

  it('caps events per request', () => {
    const sink = memorySink();
    setErrorSink(sink);
    const ingest = createIngest({ via: 'vite' });
    ingest.accept(
      {
        app: 'web',
        events: Array.from({ length: 80 }, (_, i) => ({
          ...event(i),
          where: `w${i}`,
        })),
      },
      '127.0.0.1',
    );
    expect(sink.records).toHaveLength(EVENTS_PER_REQUEST);
  });

  it('rate-limits per client and writes one summary WARN', () => {
    vi.useFakeTimers();
    const sink = memorySink();
    setErrorSink(sink);
    const ingest = createIngest({ via: 'vite' });
    for (let batch = 0; batch < 6; batch++) {
      ingest.accept(
        {
          app: 'web',
          events: Array.from({ length: 50 }, (_, i) => ({
            ...event(i),
            where: `w${batch}-${i}`,
          })),
        },
        '127.0.0.1',
      );
    }
    expect(sink.records).toHaveLength(RATE_PER_CLIENT);
    vi.advanceTimersByTime(60_000);
    expect(sink.records.at(-1)?.error).toBe(
      'dropped 60 browser reports over the rate limit',
    );
    vi.useRealTimers();
  });

  it('sanitises: control characters cannot forge a header, the stack is indented', () => {
    const sink = memorySink();
    setErrorSink(sink);
    createIngest({ via: 'vite' }).accept(
      {
        app: 'web',
        events: [
          {
            ...event(),
            doing: 'x\n[2026-01-01T00:00:00.000Z] [FATAL] forged',
            stack: 'a\n[ERROR] b',
          },
        ],
      },
      '127.0.0.1',
    );
    const text = sink.lines().join('');
    expect(text.split('\n').filter(l => l.startsWith('['))).toHaveLength(1);
    expect(sink.records[0]?.stack).toBe('    a\n    [ERROR] b');
  });
});
