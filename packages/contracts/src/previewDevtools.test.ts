import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  PreviewDevtoolsInput,
  PreviewPerformanceStartInput,
  PreviewEmulateInput,
} from "./previewDevtools.ts";

const valid = Schema.is(PreviewDevtoolsInput);
const validStart = Schema.is(PreviewPerformanceStartInput);
const validEmulation = Schema.is(PreviewEmulateInput);
it("accepts only focused DevTools actions and bounded emulation/capture settings", () => {
  expect(valid({ action: "memory" })).toBe(true);
  expect(valid({ action: "sendCommand", method: "Browser.close" })).toBe(false);
  expect(validStart({ durationSeconds: 61 })).toBe(false);
  expect(validEmulation({ cpuRate: 0 })).toBe(false);
  expect(validEmulation({ cpuRate: 4, network: "fast-4g" })).toBe(true);
  expect(valid({ action: "artifactRead", artifactId: "id", offset: -1 })).toBe(false);
});
