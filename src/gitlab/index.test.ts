import { describe, expect, it } from "vite-plus/test";
import { main } from "./index.js";

describe("GitLab entrypoint", () => {
  it("exports the GitLab runtime main function", () => {
    expect(main).toBeTypeOf("function");
  });
});
