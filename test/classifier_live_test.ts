// Live calibration against a real classifier endpoint. Never runs in CI.
//
//   GATOR_CLASSIFIER_LIVE=1 deno test -A test/classifier_live_test.ts
//
// Optional: GATOR_CLASSIFIER_ENDPOINT (default http://localhost:8086/v1),
// GATOR_CLASSIFIER_MODEL (default Qwen3.8-27B), GATOR_CLASSIFIER_THRESHOLD
// (default 0.75).
//
// Only one kind of miss fails the test: a heavy task demoted to standard. That
// puts hard work on the weaker card. A standard task kept at heavy costs only
// throughput, so it is reported but tolerated.
import { assertEquals } from "@std/assert"
import { join } from "node:path"
import { py } from "./sched_harness.ts"

const LIVE = Deno.env.get("GATOR_CLASSIFIER_LIVE") === "1"
const FIXTURE = join(import.meta.dirname!, "fixtures/classifier_labelled.json")

Deno.test({
  name: "live: no heavy-labelled task is demoted",
  ignore: !LIVE,
  fn() {
    const endpoint = Deno.env.get("GATOR_CLASSIFIER_ENDPOINT") ?? "http://localhost:8086/v1"
    const model = Deno.env.get("GATOR_CLASSIFIER_MODEL") ?? "Qwen3.8-27B"
    const threshold = Deno.env.get("GATOR_CLASSIFIER_THRESHOLD") ?? "0.75"
    const r = py(`
import json
from gator_sched.config import ClassifierConfig
from gator_sched.classify import classify, describe
c = ClassifierConfig()
c.endpoint = ${JSON.stringify(endpoint)}
c.model = ${JSON.stringify(model)}
c.threshold = ${threshold}
c.timeout = 30
out = []
for t in json.load(open(${JSON.stringify(FIXTURE)}))["tasks"]:
    v = classify(c, t["title"], t["scope"], t["task"])
    out.append({"label": t["label"], "title": t["title"], "got": v["class"], "why": describe(v)})
print(json.dumps(out))
`)
    assertEquals(r.code, 0, r.out)
    const rows: { label: string; title: string; got: string; why: string }[] = JSON.parse(r.out)
    for (const row of rows) {
      const mark = row.label === row.got ? "ok  " : row.label === "heavy" ? "FAIL" : "kept"
      console.log(`${mark} ${row.label.padEnd(8)} ${row.why.padEnd(28)} ${row.title}`)
    }
    const right = rows.filter((row) => row.label === row.got).length
    console.log(`accuracy ${right}/${rows.length}`)
    const demoted = rows.filter((row) => row.label === "heavy" && row.got === "standard")
    assertEquals(demoted.map((row) => row.title), [])
  },
})
