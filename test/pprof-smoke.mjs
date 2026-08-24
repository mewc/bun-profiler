import { writeFile } from "node:fs/promises";
import { encodePprof } from "../dist/index.js";

const output = process.argv[2];
if (!output) throw new Error("output path required");
const samples = Array.from({ length: 20 }, () => 2);
await writeFile(
  output,
  encodePprof({
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: 0,
          columnNumber: 0,
        },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "independentPprofSmoke",
          scriptId: "1",
          url: "file:///smoke.ts",
          lineNumber: 9,
          columnNumber: 0,
        },
      },
    ],
    samples,
    timeDeltas: samples.map(() => 10_000),
    startTime: 0,
    endTime: 200_000,
  })
);
