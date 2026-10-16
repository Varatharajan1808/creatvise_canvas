/**
 * Real-time FPS (Frames Per Second) and render latency performance monitor.
 * Accurately measures display refresh rate and GPU render frame duration for Creatvise Canvas.
 */

export class FpsTracker {
  private frameCount = 0;
  private lastTimestamp = performance.now();
  private lastUpdate = performance.now();
  private rafId: number | null = null;

  public fps = 60;
  public frameMs = 16.6;
  public lastRenderMs = 0;
  public minFps = 60;
  public maxFps = 60;

  /**
   * Start tracking frames using requestAnimationFrame.
   */
  start() {
    if (this.rafId !== null) return;
    this.lastTimestamp = performance.now();
    this.lastUpdate = this.lastTimestamp;

    const tick = (now: number) => {
      this.frameCount++;
      const elapsed = now - this.lastUpdate;

      // Update metrics every 350ms to ensure smooth readability without visual flicker
      if (elapsed >= 350) {
        this.fps = Math.round((this.frameCount * 1000) / elapsed);
        this.frameMs = +(1000 / Math.max(1, this.fps)).toFixed(1);

        if (this.fps > 0) {
          if (this.minFps === 60 && this.maxFps === 60) {
            this.minFps = this.fps;
            this.maxFps = this.fps;
          } else {
            this.minFps = Math.min(this.minFps, this.fps);
            this.maxFps = Math.max(this.maxFps, this.fps);
          }
        }

        this.frameCount = 0;
        this.lastUpdate = now;
        this.updateDom();
      }

      this.lastTimestamp = now;
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Stop tracking frames.
   */
  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Record the actual GPU/WebGL2/WebGPU draw execution time.
   */
  recordRenderTime(ms: number) {
    this.lastRenderMs = ms;
  }

  /**
   * Color status class based on FPS threshold:
   * >= 50 FPS: Good (Green)
   * 30 - 49 FPS: Warning (Yellow/Amber)
   * < 30 FPS: Poor (Red)
   */
  statusClass(): string {
    if (this.fps >= 50) return 'fps-dot-good';
    if (this.fps >= 30) return 'fps-dot-warn';
    return 'fps-dot-bad';
  }

  /**
   * Detailed tooltip explanation for users.
   */
  getTooltip(): string {
    const renderPart = this.lastRenderMs > 0 ? ` · GPU draw: ${this.lastRenderMs.toFixed(1)}ms` : '';
    return `Rendering: ${this.fps} FPS (${this.frameMs}ms frame budget${renderPart}) · Click for stats`;
  }

  /**
   * Generate status bar pill HTML.
   */
  getHtml(): string {
    return `
      <span id="fps-indicator" class="status-pill fps-pill" data-tooltip="${this.getTooltip()}">
        <span class="fps-dot ${this.statusClass()}"></span>
        <span class="fps-val"><strong>${this.fps}</strong> FPS</span>
        <span class="fps-ms">${this.frameMs}ms</span>
      </span>
    `.trim();
  }

  /**
   * Fine-grained DOM update without rebuilding parent containers.
   */
  updateDom() {
    const el = document.getElementById('fps-indicator');
    if (!el) return;

    const dot = el.querySelector('.fps-dot');
    if (dot) {
      dot.className = `fps-dot ${this.statusClass()}`;
    }

    const val = el.querySelector('.fps-val');
    if (val) {
      val.innerHTML = `<strong>${this.fps}</strong> FPS`;
    }

    const ms = el.querySelector('.fps-ms');
    if (ms) {
      ms.textContent = `${this.frameMs}ms`;
    }

    el.setAttribute('data-tooltip', this.getTooltip());
  }
}

export const fpsTracker = new FpsTracker();
