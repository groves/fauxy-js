// Node added recursive in 18.17 and we're requiring that or later in our engine declaration
// @types/node18 doesn't update from 18.0, so we override it by hand here
import { OpenDirOptions as OriginalOpenDirOptions } from "fs";

declare module "fs" {
  interface OpenDirOptions extends OriginalOpenDirOptions {
    recursive?: boolean;
  }
}

// Optionally, if you're using fs/promises:
declare module "fs/promises" {
  interface OpenDirOptions extends OriginalOpenDirOptions {
    recursive?: boolean;
  }
}
