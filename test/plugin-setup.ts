/** Browser APIs that tldraw and three expect but jsdom does not provide. */
const g = globalThis as Record<string, unknown>

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

if (!g.Path2D) {
  g.Path2D = class {
    rect(): void {}
    roundRect(): void {}
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  }
}

if (!g.FontFace) {
  g.FontFace = class {
    load(): Promise<void> {
      return Promise.resolve()
    }
  }
}
