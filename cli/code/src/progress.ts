/**
 * Progress UI — pm/cli.mdx §12.
 *
 * Some answers take real time: a cold bring-up waits up to 120s on /health,
 * an extraction walks four hundred PDFs. While the CLI is working, it shows
 * that it is working — otherwise an operator assumes a hang, kills it, and
 * re-runs, and now two extractions are writing the same staging directory.
 *
 * Three rules make this safe rather than decorative:
 *
 *   - It draws on STDERR only. `abx statements missing | wc -l` stays a count
 *     of months no matter what is spinning.
 *   - It is TTY-gated. Piped stderr (cron, CI, a script) gets plain one-line
 *     status messages and no animation.
 *   - The line is fully erased before ANY result, error or log tail prints,
 *     including on failure paths. No spinner residue ever prefixes real
 *     output.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export type SpinnerOptions = {
  /** --quiet suppresses the animation and the plain fallback alike. */
  quiet?: boolean;
  stream?: NodeJS.WriteStream;
};

export class Spinner {
  #stream: NodeJS.WriteStream;
  #quiet: boolean;
  #animated: boolean;
  #timer: NodeJS.Timeout | undefined;
  #frame = 0;
  #startedAt = 0;
  #phase = '';
  #count: { done: number; total: number } | undefined;
  #drawn = false;

  constructor({ quiet = false, stream = process.stderr }: SpinnerOptions = {}) {
    this.#stream = stream;
    this.#quiet = quiet;
    this.#animated = !quiet && stream.isTTY === true;
  }

  start(phase: string): void {
    this.#phase = phase;
    this.#startedAt = Date.now();
    this.#count = undefined;

    if (this.#quiet) {
      return;
    }
    if (!this.#animated) {
      // Not a TTY: say it once, plainly, and never redraw.
      this.#stream.write(`${phase}\n`);
      return;
    }

    this.#timer = setInterval(() => {
      this.#draw();
    }, INTERVAL_MS);
    // Never hold the process open for a spinner.
    this.#timer.unref();
    this.#draw();
  }

  /** Update the phase, and the count when a denominator is actually known. */
  tick(phase?: string, count?: { done: number; total: number }): void {
    if (phase !== undefined) {
      this.#phase = phase;
    }
    if (count !== undefined) {
      this.#count = count;
    }
    if (this.#animated) {
      this.#draw();
    }
  }

  /**
   * Erase the line and stop. Idempotent, and safe to call from a finally
   * block — which is where it should always be called from.
   */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#erase();
    this.#phase = '';
  }

  #erase(): void {
    if (this.#animated && this.#drawn) {
      // \r to column 0, \x1b[2K to clear the whole line — clearing before the
      // cursor would leave the tail of a longer previous frame behind.
      this.#stream.write('\r\x1b[2K');
      this.#drawn = false;
    }
  }

  #draw(): void {
    const frame = FRAMES[this.#frame % FRAMES.length] ?? FRAMES[0];
    this.#frame++;

    const elapsed = formatElapsed(Date.now() - this.#startedAt);
    // Percentages only where a denominator is known; elapsed time is the
    // honest signal otherwise, and the phase names what we are waiting on so
    // a stuck phase is diagnosable at a glance.
    const count =
      this.#count === undefined
        ? ''
        : ` ${this.#count.done}/${this.#count.total}`;

    this.#erase();
    this.#stream.write(`${frame} ${this.#phase}…${count}  ${elapsed}`);
    this.#drawn = true;
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Run `fn` with a spinner that is always stopped, including when fn throws.
 *
 * The spinner is created but NOT started: `fn` starts it at the moment there
 * is actually something to wait for. That matters because the non-TTY
 * fallback prints its phase line immediately, so starting eagerly announces
 * "Starting the sync server" on runs that find the server already up — or
 * that are about to refuse to start it at all.
 */
export async function withSpinner<T>(
  options: SpinnerOptions,
  fn: (spinner: Spinner) => Promise<T>,
): Promise<T> {
  const spinner = new Spinner(options);
  try {
    return await fn(spinner);
  } finally {
    spinner.stop();
  }
}
