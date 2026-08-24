import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { SourceMapResolver } from "../src/source-maps";
import type { CdpProfile } from "../src/types";

it("resolves bundled frames through an inline source map", async () => {
  const directory = await mkdtemp(`${tmpdir()}/bun-profiler-source-map-`);
  try {
    const map = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ["src/original.ts"],
        names: ["originalFn"],
        mappings: "AAAAA",
      })
    ).toString("base64");
    const scriptPath = `${directory}/bundle.js`;
    await writeFile(
      scriptPath,
      `function bundled(){}\n//# sourceMappingURL=data:application/json;base64,${map}`
    );
    const profile: CdpProfile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "bundled",
            scriptId: "1",
            url: pathToFileURL(scriptPath).href,
            lineNumber: 0,
            columnNumber: 0,
          },
        },
      ],
      samples: [1],
      timeDeltas: [10_000],
      startTime: 0,
      endTime: 10_000,
    };
    const resolved = await new SourceMapResolver(1).resolveProfile(profile);
    expect(resolved.nodes[0]?.callFrame.functionName).toBe("originalFn");
    expect(resolved.nodes[0]?.callFrame.url).toContain("src/original.ts");
    expect(resolved.nodes[0]?.callFrame.lineNumber).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
