declare module "js-yaml" {
  interface DumpOptions {
    /** At which nesting level to switch to flow (inline) style. -1 = block everywhere. */
    flowLevel?: number;
    /** Max line width. -1 = no wrapping. */
    lineWidth?: number;
    /** Indentation width. */
    indent?: number;
    /** Whether to sort keys. */
    sortKeys?: boolean;
  }
  function dump(obj: unknown, opts?: DumpOptions): string;
  function load(str: string): unknown;
  // eslint-disable-next-line import/no-default-export
  export default { dump, load };
}
