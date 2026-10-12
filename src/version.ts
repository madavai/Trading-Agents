declare const __VERSION__: string | undefined;
/** The package version, stamped in by the build; "dev" when run from compiled sources (the tests). */
export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
