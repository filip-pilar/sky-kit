import type { CSSProperties, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { PlaneOptions, ShapeOptions, SkyOptions } from './sky.js';

export interface SkyHandle {
  flyPlane(options?: PlaneOptions): void;
  showShape(options: ShapeOptions): Promise<void> | undefined;
  clearShape(): void;
  pause(): void;
  play(): void;
  snapshot(): string | null;
  readonly canvas: HTMLCanvasElement | null;
}

export interface SkyProps extends SkyOptions {
  className?: string;
  style?: CSSProperties;
  /** Content layered on top of the sky. */
  children?: ReactNode;
}

export declare const Sky: ForwardRefExoticComponent<SkyProps & RefAttributes<SkyHandle>>;
