// Types for render.mjs, so src/dashboard.test.ts can import it under the strict type-check.
export declare const DASHBOARD_DIR: string
export declare const ENGINE_MARKER: string
export declare const FONTS_MARKER: string
export declare const FONTS: ReadonlyArray<{ family: string; weight: string; file: string; licence: string }>
export declare function fontFaceCss(dir?: string): string
export declare function engineBundle(dir?: string): Promise<string>
export declare function renderDesk(dir?: string): Promise<{ html: string; bundleBytes: number; fontBytes: number }>
