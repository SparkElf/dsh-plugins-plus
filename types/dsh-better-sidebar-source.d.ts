/**
 * Type-check boundary for the Better Sidebar source modules that the knowledge-base
 * plugin embeds at build time. The shipped runtime still bundles the real source;
 * this shim only keeps the repository-wide type gate independent of a third-party
 * package's internal source layout.
 */
export declare const FileTree: any
export type FileTreeSort = any
export declare const referenceInChat: any
export declare const absoluteFileAddress: any
export declare const sessionFileAddress: any
export type UploadItem = any
