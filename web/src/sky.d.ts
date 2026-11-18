export type Palette = 'day' | 'summer' | 'pastel';
export type Quality = 'high' | 'balanced' | 'low';

export interface SkyOptions {
  /** 0 = still, 1 = gentle drift, 4 = brisk. Default 1. */
  speed?: number;
  /** 0 = almost clear .. 1 = lots of cloud. Default 0.6. */
  coverage?: number;
  /** Shading inside clouds, 0 .. 1. Default 0.3. */
  shadow?: number;
  /** Cloud size multiplier. Default 1. */
  cloudScale?: number;
  /** Which way the clouds drift. Default 'left'. */
  direction?: 'left' | 'right';
  /** Any number gives a different sky. Default 0. */
  seed?: number;
  /** Sky colours. Default 'day'. */
  palette?: Palette;
  /** Custom sky colours (hex, e.g. '#2a7be4'); override the palette when set. */
  skyTop?: string | null;
  skyMid?: string | null;
  skyLow?: string | null;
  /** Resolution of the cloud snapshots. Default 'high'. */
  quality?: Quality;
  /** Frame cap. Default 60. */
  fps?: number;
  /** Pointer movement gently pushes the clouds, which then settle back. Default false. */
  interactive?: boolean;
  /** Occasional planes with contrails. Default false. */
  planes?: boolean;
  /** Seconds a contrail lingers. Default 40. */
  trailLife?: number;
  /** Hold still when the user prefers reduced motion. Default true. */
  respectReducedMotion?: boolean;
}

export interface ShapeOptions {
  /** Text or emoji to form. */
  text?: string;
  /** Silhouette image: transparent PNG/SVG (alpha is used) or opaque image (dark = shape). URL or element. */
  image?: string | HTMLImageElement | HTMLCanvasElement | ImageBitmap;
  /** Centre, 0..1 of the view (y = 0 is the bottom). Default 0.5, 0.6. */
  x?: number;
  y?: number;
  /** Height of the shape as a fraction of the view height. Default 0.32. */
  size?: number;
  /** Seconds to condense, hold, and melt back into ordinary clouds. Default 4, 6, 8. */
  form?: number;
  hold?: number;
  fade?: number;
}

export interface PlaneOptions {
  /** Start and end points, 0..1 of the view (y = 0 is the bottom). Default: random side. */
  from?: [number, number];
  to?: [number, number];
}

export interface Sky {
  readonly canvas: HTMLCanvasElement;
  readonly options: Required<SkyOptions>;
  set(options: SkyOptions): void;
  pause(): void;
  play(): void;
  flyPlane(options?: PlaneOptions): void;
  /** Needs speed > 0: shapes form as the sky moves on. */
  showShape(options: ShapeOptions): Promise<void>;
  clearShape(): void;
  /** PNG data URL of the current frame, or null before the first frame. */
  snapshot(): string | null;
  destroy(): void;
}

export declare const SKY_DEFAULTS: Required<SkyOptions>;
export declare const PALETTES: Record<Palette, { skyTop: string; skyMid: string; skyLow: string }>;
/** One cloud unit in pixels for a w×h view. */
export declare function cloudUnit(w: number, h: number, cloudScale?: number): number;
export declare function createSky(container: HTMLElement, options?: SkyOptions): Sky;
