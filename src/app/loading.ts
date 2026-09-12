/**
 * Loading overlay: five messages shown in order as the real stages complete,
 * a progress bar, then a fade-out. The message log stays in the DOM
 * (`data-testid="loading-log"`) so tests can assert the order.
 */
export const LOADING_MESSAGES = [
  "LOADING MODELS & WATER",
  "LOADING ENVIRONMENT",
  "GENERATING SKY",
  "COMPILING SHADERS",
  "READY",
] as const;

export class LoadingOverlay {
  readonly el: HTMLElement;
  private readonly message: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly log: HTMLElement;
  private stage = -1;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "loading";
    this.el.dataset.testid = "loading";
    this.el.innerHTML = `
      <div class="loading-wordmark">FFT OCEAN <span>DEMO</span></div>
      <div class="loading-message" data-testid="loading-message"></div>
      <div class="loading-bar"><div class="loading-fill" data-testid="loading-fill"></div></div>
      <ol class="loading-log" data-testid="loading-log"></ol>`;
    parent.appendChild(this.el);
    this.message = this.el.querySelector(".loading-message") as HTMLElement;
    this.bar = this.el.querySelector(".loading-fill") as HTMLElement;
    this.log = this.el.querySelector(".loading-log") as HTMLElement;
  }

  /** Advance to the next message and yield a frame so it paints. */
  async next(): Promise<void> {
    this.stage = Math.min(this.stage + 1, LOADING_MESSAGES.length - 1);
    const text = LOADING_MESSAGES[this.stage] as string;
    this.message.textContent = text;
    const li = document.createElement("li");
    li.textContent = text;
    this.log.appendChild(li);
    this.bar.style.width = `${((this.stage + 1) / LOADING_MESSAGES.length) * 100}%`;
    await nextFrame();
    await nextFrame();
  }

  /**
   * Stop here: show `message` (e.g. an unsupported GPU) and keep the overlay
   * up. `data-state="failed"` marks it for tests and styling.
   */
  fail(message: string): void {
    this.message.textContent = message;
    this.el.dataset.state = "failed";
    this.el.classList.add("is-failed");
    this.bar.style.width = "0";
  }

  /** Fade out and remove from the flow (kept in the DOM, hidden). */
  async finish(): Promise<void> {
    while (this.stage < LOADING_MESSAGES.length - 1) await this.next();
    await sleep(250);
    this.el.classList.add("is-done");
    await sleep(450);
    this.el.hidden = true;
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
