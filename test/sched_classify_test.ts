// The task-difficulty classifier: prompt, readout and decision.
//
// The readout is where an untrusted response meets the controller, so most of
// these tests are adversarial: whatever the endpoint says, the only possible
// outcomes are heavy, standard, or an abstention that means heavy.
import { assertEquals, assertStringIncludes } from "@std/assert"
import { cfg, classifierStub, py, schedStdin, store } from "./sched_harness.ts"

/** Run readout() on a Python literal and print the result or the abstention code. */
function readout(literal: string): string {
  const r = py(`
import json
from gator_sched.classify import Abstain, readout
nan = float("nan")
try:
    d = readout(${literal})
    print(json.dumps({k: round(v, 3) for k, v in d.items()}, sort_keys=True))
except Abstain as a:
    print("abstain", a.code)
`)
  assertEquals(r.code, 0, r.out)
  return r.out.trim()
}

/** A chat-completions response whose first token carries these alternatives. */
const logprobs = (pairs: string) => `
{"choices": [{"logprobs": {"content": [{"token": "x", "logprob": -0.1,
  "top_logprobs": [${pairs}]}]}}]}`

const lp = (token: string, p: number) =>
  `{"token": ${JSON.stringify(token)}, "logprob": ${Math.log(p)}}`

// ============================================================= build_request

Deno.test("the request asks for one scored token and nothing else", () => {
  const r = py(`
import json
from gator_sched.classify import build_request
b = build_request("Qwen3.8-27B", "t", "src/**", "do the thing")
print(json.dumps({k: b[k] for k in ("model", "max_tokens", "temperature", "logprobs", "top_logprobs")}))
`)
  assertEquals(r.code, 0, r.out)
  assertEquals(JSON.parse(r.out), {
    model: "Qwen3.8-27B",
    max_tokens: 1,
    temperature: 0,
    logprobs: true,
    top_logprobs: 20,
  })
})

Deno.test("the task is fenced as untrusted data, after the instructions", () => {
  const r = py(`
from gator_sched.classify import build_request
print(build_request("m", "Title here", "src/**", "TASK BODY")["messages"][0]["content"])
`)
  assertEquals(r.code, 0, r.out)
  const text = r.out
  const fence = text.indexOf("--- BEGIN TASK")
  assertEquals(fence > text.indexOf("H = heavy"), true, text)
  assertEquals(text.indexOf("TASK BODY") > fence, true, text)
  assertEquals(text.indexOf("TASK BODY") < text.indexOf("--- END TASK"), true, text)
  assertStringIncludes(text, "Title: Title here")
  assertStringIncludes(text, "Scope: src/**")
})

Deno.test("substitution is one pass: a title naming a placeholder is not expanded", () => {
  const r = py(`
from gator_sched.classify import build_request
print(build_request("m", "<<TASK>>", "s", "SECRET-TASK")["messages"][0]["content"])
`)
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, "Title: <<TASK>>")
  assertEquals(r.out.split("SECRET-TASK").length - 1, 1, r.out)
})

Deno.test("task text is capped at 16 KB, keeping the head", () => {
  const r = py(`
from gator_sched.classify import build_request
task = "a" * 16384 + "b" * 30000
content = build_request("m", "t", "s", task)["messages"][0]["content"]
print("a" * 16384 in content, "b" in content.split("--- BEGIN TASK")[1].split("--- END TASK")[0])
`)
  assertEquals(r.code, 0, r.out)
  assertEquals(r.out.trim(), "True False")
})

// ================================================================== readout

Deno.test("readout sums every token variant of an option", () => {
  assertEquals(
    readout(logprobs([lp("S", 0.5), lp(" S", 0.3), lp("H", 0.2)].join(","))),
    '{"heavy": 0.2, "standard": 0.8}',
  )
})

Deno.test("readout accepts the post-sampling shape as well", () => {
  const body = `{"choices": [{"logprobs": {"content": [{"token": "S", "prob": 0.9,
    "top_probs": [{"token": "S", "prob": 0.9}, {"token": "H", "prob": 0.1}]}]}}]}`
  assertEquals(readout(body), '{"heavy": 0.1, "standard": 0.9}')
})

Deno.test("readout abstains off_target when the options are not what the model wanted to say", () => {
  assertEquals(
    readout(logprobs([lp("We", 0.9), lp("S", 0.05), lp("H", 0.05)].join(","))),
    "abstain off_target",
  )
})

Deno.test("readout abstains no_logprobs when there are none", () => {
  assertEquals(readout(`{"choices": [{"message": {"content": "S"}}]}`), "abstain no_logprobs")
  assertEquals(readout(`{"choices": [{"logprobs": {"content": []}}]}`), "abstain no_logprobs")
  assertEquals(readout(`{"choices": []}`), "abstain no_logprobs")
  assertEquals(readout(`"not an object"`), "abstain no_logprobs")
})

Deno.test("readout abstains bad_response on values no model produces", () => {
  assertEquals(readout(logprobs(`{"token": "S", "logprob": nan}`)), "abstain bad_response")
  assertEquals(readout(logprobs(`{"token": "S", "logprob": 2.0}`)), "abstain bad_response")
  assertEquals(readout(logprobs(`{"token": "S", "logprob": "high"}`)), "abstain bad_response")
  assertEquals(readout(logprobs(`{"token": 7, "logprob": -0.1}`)), "abstain bad_response")
  assertEquals(readout(logprobs(`"S"`)), "abstain bad_response")
  const probs = (p: string) =>
    `{"choices": [{"logprobs": {"content": [{"token": "S", "top_probs": [{"token": "S", "prob": ${p}}]}]}}]}`
  assertEquals(readout(probs("1.5")), "abstain bad_response")
  assertEquals(readout(probs("-0.1")), "abstain bad_response")
  assertEquals(readout(probs("True")), "abstain bad_response")
})

Deno.test("a response naming classes or remote cannot produce anything but the two options", () => {
  // Tokens that spell other classes are simply not options. With nothing on
  // target the readout abstains, and an abstention is heavy.
  assertEquals(
    readout(
      logprobs([lp("remote", 0.6), lp("R", 0.2), lp("light", 0.1), lp("heavy", 0.1)].join(",")),
    ),
    "abstain off_target",
  )
  // Mixed in with a real option, they are ignored and only H and S count.
  assertEquals(
    readout(logprobs([lp("remote", 0.3), lp("S", 0.6), lp("H", 0.1)].join(","))),
    '{"heavy": 0.143, "standard": 0.857}',
  )
})

// =================================================================== decide

Deno.test("decide: standard only at or above the threshold, over 500 random cases", () => {
  const r = py(`
import random
from gator_sched.classify import decide
rng = random.Random(20260921)
bad = []
for _ in range(500):
    s = rng.random()
    t = rng.uniform(0.5000001, 1.0)
    got = decide({"heavy": 1 - s, "standard": s}, t)
    want = "standard" if s >= t else "heavy"
    if got != want or got not in ("heavy", "standard"):
        bad.append((s, t, got))
print(len(bad), bad[:3])
`)
  assertEquals(r.code, 0, r.out)
  assertEquals(r.out.trim(), "0 []")
})

Deno.test("decide at exactly the threshold demotes", () => {
  const r = py(`
from gator_sched.classify import decide
print(decide({"heavy": 0.25, "standard": 0.75}, 0.75), decide({"heavy": 0.26, "standard": 0.74}, 0.75))
`)
  assertEquals(r.out.trim(), "standard heavy")
})

// ================================================================= describe

Deno.test("describe prints only numbers and the module's own codes", () => {
  const r = py(`
from gator_sched.classify import abstained, describe
print(describe({"class": "standard", "p_standard": 0.9412}))
print(describe({"class": "heavy", "p_standard": 0.31}))
print(describe(abstained("timeout")))
print(abstained("timeout"))
`)
  assertEquals(r.code, 0, r.out)
  assertEquals(
    r.out.trim().split("\n"),
    [
      "standard p_standard=0.94",
      "heavy p_standard=0.31",
      "abstained:timeout",
      "{'class': 'heavy', 'abstained': 'timeout'}",
    ],
  )
})

// ================================================================ transport

/** classify() against a URL, printed as JSON. */
function classifyAt(url: string, threshold = 0.75): Record<string, unknown> {
  const r = py(`
import json
from gator_sched.config import ClassifierConfig
from gator_sched.classify import classify
c = ClassifierConfig()
c.endpoint = ${JSON.stringify(url)}
c.model = "stub-model"
c.threshold = ${threshold}
c.timeout = 1
print(json.dumps(classify(c, "a title", "src/**", "the task text")))
`)
  assertEquals(r.code, 0, r.out)
  return JSON.parse(r.out)
}

async function withStub(mode: string, fn: (s: Awaited<ReturnType<typeof classifierStub>>) => void) {
  const stub = await classifierStub(mode)
  try {
    fn(stub)
  } finally {
    await stub.stop()
  }
}

Deno.test("classify posts one chat completion and demotes a confident standard", async () => {
  await withStub("standard", (stub) => {
    const v = classifyAt(stub.url)
    assertEquals(v.class, "standard")
    assertEquals(Math.round((v.p_standard as number) * 100), 95)
    const reqs = stub.requests()
    assertEquals(reqs.length, 1)
    assertEquals(reqs[0].path, "/v1/chat/completions")
    assertEquals(reqs[0].body.model, "stub-model")
    assertStringIncludes(reqs[0].body.messages[0].content, "the task text")
  })
})

Deno.test("classify keeps a confident heavy at heavy", async () => {
  await withStub("heavy", (stub) => assertEquals(classifyAt(stub.url).class, "heavy"))
})

Deno.test("classify keeps a borderline standard at heavy: 0.70 is under 0.75", async () => {
  await withStub("borderline", (stub) => {
    const v = classifyAt(stub.url)
    assertEquals(v.class, "heavy")
    assertEquals(v.p_standard, 0.7)
    assertEquals(classifyAt(stub.url, 0.6).class, "standard")
  })
})

for (
  const [mode, code] of [
    ["off_target", "off_target"],
    ["no_logprobs", "no_logprobs"],
    ["garbage", "bad_response"],
    ["huge", "bad_response"],
    ["nested", "bad_response"],
    ["bigint", "bad_response"],
  ]
) {
  Deno.test(`classify abstains ${code} on a ${mode} endpoint, and abstaining is heavy`, async () => {
    await withStub(mode, (stub) => {
      assertEquals(classifyAt(stub.url), { class: "heavy", abstained: code })
    })
  })
}

Deno.test("classify abstains timeout within the configured bound", async () => {
  await withStub("timeout", (stub) => {
    const start = performance.now()
    assertEquals(classifyAt(stub.url), { class: "heavy", abstained: "timeout" })
    assertEquals(performance.now() - start < 5000, true)
  })
})

Deno.test("classify abstains unreachable when nothing is listening", async () => {
  const stub = await classifierStub("heavy")
  const url = stub.url
  await stub.stop()
  assertEquals(classifyAt(url), { class: "heavy", abstained: "unreachable" })
})

// ============================================================ resolve verb

const field = (out: string, key: string) =>
  (out.split("\n").find((l) => l.startsWith(`${key}=`)) ?? "").slice(key.length + 1)

Deno.test("resolve classifies the task it reads on stdin", async () => {
  await withStub("standard", (stub) => {
    const p = cfg(`classifier.endpoint = ${stub.url}\nclassifier.model = m\n`)
    const r = schedStdin(
      [
        "resolve",
        "--store",
        store(),
        "--role",
        "heavy",
        "--title",
        "T",
        "--scope",
        "src/**",
        "--task-stdin",
        "--config",
        p,
      ],
      "a task that arrived on stdin",
    )
    assertEquals(r.code, 0, r.out)
    assertEquals(field(r.out, "resource"), "standard")
    assertEquals(field(r.out, "eligible"), "local-4090,local-5090")
    assertEquals(field(r.out, "source"), "classifier")
    assertEquals(field(r.out, "classifier"), "standard p_standard=0.95")
    assertStringIncludes(
      stub.requests()[0].body.messages[0].content,
      "a task that arrived on stdin",
    )
  })
})

Deno.test("resolve with an override never contacts the classifier", async () => {
  await withStub("standard", (stub) => {
    const p = cfg(`classifier.endpoint = ${stub.url}\nclassifier.model = m\n`)
    const r = schedStdin(
      [
        "resolve",
        "--store",
        store(),
        "--role",
        "heavy",
        "--override",
        "heavy",
        "--task-stdin",
        "--config",
        p,
      ],
      "task",
    )
    assertEquals(field(r.out, "source"), "override")
    assertEquals(field(r.out, "classifier"), "")
    assertEquals(stub.requests().length, 0)
  })
})

Deno.test("resolve refuses an invalid classifier config with exit 2", () => {
  const p = cfg(
    "classifier.endpoint = http://127.0.0.1:1/v1\nclassifier.model = m\nclassifier.threshold = 0.4\n",
  )
  const r = schedStdin([
    "resolve",
    "--store",
    store(),
    "--role",
    "heavy",
    "--task-stdin",
    "--config",
    p,
  ], "t")
  assertEquals(r.code, 2, r.out)
  assertStringIncludes(r.out, "bad_threshold")
})
